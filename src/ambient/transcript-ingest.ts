/**
 * Transcript Ingestion Module
 *
 * Watches a configurable directory for new audio files (or pre-transcribed text files).
 * Audio files are transcribed via OpenAI Whisper API, then injected into NanoClaw
 * as messages so the agent can process them.
 *
 * Handles large WAV files automatically by splitting into <24MB chunks.
 * A 10-hour recording at 1MB/min (~600MB) is split into ~25 chunks,
 * each transcribed separately with context carried between chunks.
 *
 * Supported input formats:
 * - .txt, .md: treated as pre-transcribed text, injected directly
 * - .wav: split into chunks if >24MB, transcribed via Whisper
 * - .mp3, .m4a, .ogg, .webm, .flac: transcribed via Whisper (must be <25MB each)
 *
 * Usage:
 *   Drop audio files into the inbox directory (default: data/audio-inbox/).
 *   The watcher picks them up, transcribes, injects as [Transcript] messages,
 *   then moves them to data/audio-processed/.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { splitWav, wavNeedsSplitting } from './wav-splitter.js';

export interface TranscriptIngestConfig {
  /** Directory to watch for new audio/text files */
  inboxDir: string;
  /** Directory to move processed files to */
  processedDir: string;
  /** Poll interval in ms (default: 5000) */
  pollInterval: number;
  /** OpenAI API key for Whisper (read from .env or config) */
  openaiApiKey?: string;
  /** Whisper model (default: whisper-1) */
  whisperModel: string;
  /** Callback to inject transcript as a message */
  onTranscript: (transcript: string, sourceFile: string) => Promise<void>;
}

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.webm', '.flac']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md']);

const MIME_MAP: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/m4a',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

/**
 * Transcribe a single audio buffer using OpenAI Whisper API.
 * @param previousText - Last ~200 chars from previous chunk for continuity
 */
async function transcribeBuffer(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  apiKey: string,
  model: string,
  previousText?: string,
): Promise<string> {
  const openaiModule = await import('openai');
  const OpenAI = openaiModule.default;
  const toFile = openaiModule.toFile;

  const client = new OpenAI({ apiKey });
  const file = await toFile(buffer, filename, { type: mimeType });

  const transcription = await client.audio.transcriptions.create({
    file,
    model,
    response_format: 'text' as const,
    // Pass context from previous chunk to maintain continuity across splits
    ...(previousText ? { prompt: previousText.slice(-200) } : {}),
  });

  return (transcription as unknown as string).trim();
}

/**
 * Transcribe an audio file, handling large WAV files by splitting into chunks.
 */
async function transcribeAudio(
  filePath: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = MIME_MAP[ext] || 'audio/mpeg';

  // Large WAV files: split into chunks and transcribe each
  if (ext === 'wav' && wavNeedsSplitting(filePath)) {
    const stat = fs.statSync(filePath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(0);
    const chunks = splitWav(filePath);
    logger.info(
      { file: path.basename(filePath), sizeMB, chunks: chunks.length },
      'Splitting large WAV for transcription',
    );

    const transcripts: string[] = [];
    let previousText = '';

    for (let i = 0; i < chunks.length; i++) {
      logger.info(
        { chunk: `${i + 1}/${chunks.length}`, file: path.basename(filePath) },
        'Transcribing chunk',
      );

      const text = await transcribeBuffer(
        chunks[i],
        `chunk-${i}.wav`,
        'audio/wav',
        apiKey,
        model,
        previousText || undefined,
      );

      if (text) {
        transcripts.push(text);
        previousText = text;
      }
    }

    return transcripts.join(' ');
  }

  // Small files: transcribe directly
  const buffer = fs.readFileSync(filePath);
  return transcribeBuffer(buffer, path.basename(filePath), mimeType, apiKey, model);
}

/**
 * Check if a file is still being written to (e.g. USB copy in progress).
 * Waits for file size to stabilize over 2 seconds.
 */
async function waitForStableFile(filePath: string): Promise<boolean> {
  try {
    const size1 = fs.statSync(filePath).size;
    await new Promise((r) => setTimeout(r, 2000));
    if (!fs.existsSync(filePath)) return false;
    const size2 = fs.statSync(filePath).size;
    return size1 === size2 && size2 > 0;
  } catch {
    return false;
  }
}

/**
 * Start the transcript ingestion watcher.
 * Returns a cleanup function to stop the watcher.
 */
export function startTranscriptIngest(config: TranscriptIngestConfig): () => void {
  const { inboxDir, processedDir, pollInterval, onTranscript } = config;

  // Ensure directories exist
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  let running = true;

  const processFile = async (filename: string) => {
    const filePath = path.join(inboxDir, filename);
    const ext = path.extname(filename).toLowerCase();

    try {
      // Wait for file to finish copying (USB transfer may be slow)
      const stable = await waitForStableFile(filePath);
      if (!stable) {
        logger.debug({ filename }, 'File not stable yet, skipping this cycle');
        return;
      }

      let transcript: string;

      if (TEXT_EXTENSIONS.has(ext)) {
        transcript = fs.readFileSync(filePath, 'utf-8').trim();
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        if (!config.openaiApiKey) {
          logger.warn({ filename }, 'No OpenAI API key configured, skipping audio file');
          return;
        }
        const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
        logger.info({ filename, sizeMB: `${sizeMB}MB` }, 'Transcribing audio file');
        transcript = await transcribeAudio(filePath, config.openaiApiKey, config.whisperModel);
      } else {
        logger.debug({ filename }, 'Ignoring file with unsupported extension');
        return;
      }

      if (!transcript) {
        logger.warn({ filename }, 'Empty transcript, skipping');
        return;
      }

      // Inject transcript
      await onTranscript(transcript, filename);
      logger.info(
        { filename, chars: transcript.length },
        'Transcript ingested',
      );

      // Move to processed directory
      const destPath = path.join(processedDir, `${Date.now()}_${filename}`);
      fs.renameSync(filePath, destPath);
    } catch (err) {
      logger.error({ filename, err }, 'Failed to process transcript file');
      // Move to processed with error prefix to avoid retry loop
      try {
        const errPath = path.join(processedDir, `ERROR_${Date.now()}_${filename}`);
        fs.renameSync(filePath, errPath);
      } catch {
        // If we can't even move it, leave it — will retry next poll
      }
    }
  };

  const poll = async () => {
    if (!running) return;

    try {
      if (!fs.existsSync(inboxDir)) return;
      const files = fs.readdirSync(inboxDir).sort();

      for (const file of files) {
        if (!running) break;
        if (file.startsWith('.') || file.startsWith('_')) continue;
        await processFile(file);
      }
    } catch (err) {
      logger.error({ err }, 'Error polling transcript inbox');
    }

    if (running) {
      setTimeout(poll, pollInterval);
    }
  };

  logger.info({ inboxDir, pollInterval }, 'Transcript ingest watcher started');
  poll();

  return () => {
    running = false;
    logger.info('Transcript ingest watcher stopped');
  };
}

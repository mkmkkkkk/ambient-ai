/**
 * Transcript Ingestion Module
 *
 * Watches a configurable directory for new audio files (or pre-transcribed text files).
 * Audio files are transcribed via OpenAI Whisper API, then injected into NanoClaw
 * as messages so the agent can process them.
 *
 * Supported input formats:
 * - .txt files: treated as pre-transcribed text, injected directly
 * - .wav, .mp3, .m4a, .ogg, .webm, .flac: transcribed via Whisper then injected
 *
 * Usage:
 *   Drop audio files into the inbox directory (default: data/audio-inbox/).
 *   The watcher picks them up, transcribes, injects as [Transcript] messages,
 *   then moves them to data/audio-processed/.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

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

/**
 * Transcribe an audio file using OpenAI Whisper API.
 */
async function transcribeAudio(
  filePath: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const openaiModule = await import('openai');
  const OpenAI = openaiModule.default;
  const toFile = openaiModule.toFile;

  const client = new OpenAI({ apiKey });
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1); // e.g. 'mp3'
  const mimeMap: Record<string, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/m4a',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
    flac: 'audio/flac',
  };

  const file = await toFile(buffer, path.basename(filePath), {
    type: mimeMap[ext] || 'audio/mpeg',
  });

  const transcription = await client.audio.transcriptions.create({
    file,
    model,
    response_format: 'text',
  });

  // When response_format='text', SDK returns a plain string
  return (transcription as unknown as string).trim();
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
      let transcript: string;

      if (TEXT_EXTENSIONS.has(ext)) {
        // Pre-transcribed text file — read directly
        transcript = fs.readFileSync(filePath, 'utf-8').trim();
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        // Audio file — transcribe via Whisper
        if (!config.openaiApiKey) {
          logger.warn({ filename }, 'No OpenAI API key configured, skipping audio file');
          return;
        }
        logger.info({ filename }, 'Transcribing audio file');
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
      logger.info({ filename, length: transcript.length }, 'Transcript ingested');

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
      const files = fs.readdirSync(inboxDir).sort(); // Process in order

      for (const file of files) {
        if (!running) break;
        // Skip hidden files and temp files
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

  // Start polling
  logger.info({ inboxDir, pollInterval }, 'Transcript ingest watcher started');
  poll();

  // Return cleanup function
  return () => {
    running = false;
    logger.info('Transcript ingest watcher stopped');
  };
}

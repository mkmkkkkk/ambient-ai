/**
 * Transcript Ingestion Module
 *
 * Watches a directory for new audio files (or pre-transcribed text files).
 * Audio files are transcribed via a configurable backend (Soniox, Whisper, Groq),
 * then injected into NanoClaw as messages so the agent can process them.
 *
 * Backends:
 * - **soniox**: Best for bilingual EN/CN code-switching. Async file API with
 *   speaker diarization and per-token language identification.
 * - **whisper**: OpenAI Whisper API (whisper-1 / gpt-4o-transcribe). Single-language
 *   detection per 30s chunk — poor for code-switching.
 * - **groq**: Groq-hosted Whisper (whisper-large-v3-turbo). Cheapest option,
 *   same limitations as Whisper for code-switching.
 *
 * Handles large WAV files automatically by splitting into <24MB chunks (Whisper/Groq).
 * Soniox accepts files up to 1GB natively — no splitting needed.
 *
 * Supported input formats:
 * - .txt, .md: treated as pre-transcribed text, injected directly
 * - .wav, .mp3, .m4a, .ogg, .webm, .flac: transcribed via configured backend
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { splitWav, wavNeedsSplitting } from './wav-splitter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscriptionBackend = 'soniox' | 'whisper' | 'groq';

export interface TranscriptIngestConfig {
  /** Directory to watch for new audio/text files */
  inboxDir: string;
  /** Directory to move processed files to */
  processedDir: string;
  /** Poll interval in ms (default: 5000) */
  pollInterval: number;
  /** Transcription backend (default: soniox) */
  backend?: TranscriptionBackend;
  /** Soniox API key */
  sonioxApiKey?: string;
  /** OpenAI API key for Whisper */
  openaiApiKey?: string;
  /** Groq API key */
  groqApiKey?: string;
  /** Whisper model (default: whisper-1) */
  whisperModel?: string;
  /** Language hints for Soniox (default: ['en', 'zh']) */
  languageHints?: string[];
  /** Enable speaker diarization (Soniox only, default: true) */
  enableDiarization?: boolean;
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

// ---------------------------------------------------------------------------
// Soniox Backend
// ---------------------------------------------------------------------------

const SONIOX_BASE = 'https://api.soniox.com/v1';

async function sonioxUploadFile(
  filePath: string,
  apiKey: string,
): Promise<string> {
  const formData = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);
  formData.append('file', blob, path.basename(filePath));

  const res = await fetch(`${SONIOX_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Soniox upload failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

async function sonioxCreateTranscription(
  fileId: string,
  apiKey: string,
  languageHints: string[],
  enableDiarization: boolean,
): Promise<string> {
  const res = await fetch(`${SONIOX_BASE}/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'stt-async-v4',
      file_id: fileId,
      language_hints: languageHints,
      enable_language_identification: true,
      enable_speaker_diarization: enableDiarization,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Soniox create transcription failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

async function sonioxPollUntilDone(
  transcriptionId: string,
  apiKey: string,
): Promise<void> {
  const maxWait = 600_000; // 10 minutes
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const res = await fetch(`${SONIOX_BASE}/transcriptions/${transcriptionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Soniox poll failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      status: string;
      error_message?: string;
    };

    if (data.status === 'completed') return;
    if (data.status === 'error') {
      throw new Error(`Soniox transcription error: ${data.error_message}`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error('Soniox transcription timed out after 10 minutes');
}

interface SonioxToken {
  text: string;
  speaker?: number;
  language?: string;
}

async function sonioxGetTranscript(
  transcriptionId: string,
  apiKey: string,
): Promise<string> {
  const res = await fetch(
    `${SONIOX_BASE}/transcriptions/${transcriptionId}/transcript`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Soniox get transcript failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { tokens: SonioxToken[] };
  return data.tokens.map((t) => t.text).join('');
}

async function transcribeWithSoniox(
  filePath: string,
  apiKey: string,
  languageHints: string[],
  enableDiarization: boolean,
): Promise<string> {
  const filename = path.basename(filePath);
  const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);

  logger.info({ filename, sizeMB: `${sizeMB}MB` }, 'Uploading to Soniox');
  const fileId = await sonioxUploadFile(filePath, apiKey);

  logger.info({ filename, fileId }, 'Creating Soniox transcription');
  const txnId = await sonioxCreateTranscription(
    fileId,
    apiKey,
    languageHints,
    enableDiarization,
  );

  logger.info({ filename, txnId }, 'Waiting for Soniox transcription');
  await sonioxPollUntilDone(txnId, apiKey);

  const transcript = await sonioxGetTranscript(txnId, apiKey);
  logger.info(
    { filename, chars: transcript.length },
    'Soniox transcription complete',
  );

  return transcript;
}

// ---------------------------------------------------------------------------
// Whisper Backend (OpenAI)
// ---------------------------------------------------------------------------

async function transcribeBufferWhisper(
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
    ...(previousText ? { prompt: previousText.slice(-200) } : {}),
  });

  return (transcription as unknown as string).trim();
}

async function transcribeWithWhisper(
  filePath: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = MIME_MAP[ext] || 'audio/mpeg';

  // Large WAV files: split into chunks
  if (ext === 'wav' && wavNeedsSplitting(filePath)) {
    const stat = fs.statSync(filePath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(0);
    const chunks = splitWav(filePath);
    logger.info(
      { file: path.basename(filePath), sizeMB, chunks: chunks.length },
      'Splitting large WAV for Whisper',
    );

    const transcripts: string[] = [];
    let previousText = '';

    for (let i = 0; i < chunks.length; i++) {
      logger.info(
        { chunk: `${i + 1}/${chunks.length}` },
        'Transcribing chunk',
      );

      const text = await transcribeBufferWhisper(
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
  return transcribeBufferWhisper(
    buffer,
    path.basename(filePath),
    mimeType,
    apiKey,
    model,
  );
}

// ---------------------------------------------------------------------------
// Groq Backend (Whisper on Groq)
// ---------------------------------------------------------------------------

async function transcribeWithGroq(
  filePath: string,
  apiKey: string,
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = MIME_MAP[ext] || 'audio/mpeg';

  // Groq also has 25MB limit — reuse WAV splitting
  if (ext === 'wav' && wavNeedsSplitting(filePath)) {
    const chunks = splitWav(filePath);
    logger.info(
      { file: path.basename(filePath), chunks: chunks.length },
      'Splitting large WAV for Groq',
    );

    const transcripts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      logger.info({ chunk: `${i + 1}/${chunks.length}` }, 'Transcribing chunk (Groq)');
      const text = await groqTranscribeBuffer(chunks[i], `chunk-${i}.wav`, 'audio/wav', apiKey);
      if (text) transcripts.push(text);
    }
    return transcripts.join(' ');
  }

  const buffer = fs.readFileSync(filePath);
  return groqTranscribeBuffer(buffer, path.basename(filePath), mimeType, apiKey);
}

async function groqTranscribeBuffer(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'text');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq transcription failed (${res.status}): ${text}`);
  }

  return (await res.text()).trim();
}

// ---------------------------------------------------------------------------
// File Stability Check
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main Transcription Router
// ---------------------------------------------------------------------------

async function transcribeAudio(
  filePath: string,
  config: TranscriptIngestConfig,
): Promise<string> {
  const backend = config.backend || 'soniox';

  switch (backend) {
    case 'soniox': {
      if (!config.sonioxApiKey) {
        throw new Error('SONIOX_API_KEY required for soniox backend');
      }
      return transcribeWithSoniox(
        filePath,
        config.sonioxApiKey,
        config.languageHints || ['en', 'zh'],
        config.enableDiarization !== false,
      );
    }
    case 'whisper': {
      if (!config.openaiApiKey) {
        throw new Error('OPENAI_API_KEY required for whisper backend');
      }
      return transcribeWithWhisper(
        filePath,
        config.openaiApiKey,
        config.whisperModel || 'whisper-1',
      );
    }
    case 'groq': {
      if (!config.groqApiKey) {
        throw new Error('GROQ_API_KEY required for groq backend');
      }
      return transcribeWithGroq(filePath, config.groqApiKey);
    }
    default:
      throw new Error(`Unknown transcription backend: ${backend}`);
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export function startTranscriptIngest(config: TranscriptIngestConfig): () => void {
  const { inboxDir, processedDir, pollInterval, onTranscript } = config;
  const backend = config.backend || 'soniox';

  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  let running = true;

  const processFile = async (filename: string) => {
    const filePath = path.join(inboxDir, filename);
    const ext = path.extname(filename).toLowerCase();

    try {
      const stable = await waitForStableFile(filePath);
      if (!stable) {
        logger.debug({ filename }, 'File not stable yet, skipping this cycle');
        return;
      }

      let transcript: string;

      if (TEXT_EXTENSIONS.has(ext)) {
        transcript = fs.readFileSync(filePath, 'utf-8').trim();
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        const hasKey =
          (backend === 'soniox' && config.sonioxApiKey) ||
          (backend === 'whisper' && config.openaiApiKey) ||
          (backend === 'groq' && config.groqApiKey);

        if (!hasKey) {
          logger.warn(
            { filename, backend },
            `No API key configured for ${backend} backend, skipping audio file`,
          );
          return;
        }

        const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
        logger.info(
          { filename, sizeMB: `${sizeMB}MB`, backend },
          'Transcribing audio file',
        );
        transcript = await transcribeAudio(filePath, config);
      } else {
        logger.debug({ filename }, 'Ignoring file with unsupported extension');
        return;
      }

      if (!transcript) {
        logger.warn({ filename }, 'Empty transcript, skipping');
        return;
      }

      await onTranscript(transcript, filename);
      logger.info({ filename, chars: transcript.length }, 'Transcript ingested');

      const destPath = path.join(processedDir, `${Date.now()}_${filename}`);
      fs.renameSync(filePath, destPath);
    } catch (err) {
      logger.error({ filename, err }, 'Failed to process transcript file');
      try {
        const errPath = path.join(processedDir, `ERROR_${Date.now()}_${filename}`);
        fs.renameSync(filePath, errPath);
      } catch {
        // Leave it — will retry next poll
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

  logger.info({ inboxDir, pollInterval, backend }, 'Transcript ingest watcher started');
  poll();

  return () => {
    running = false;
    logger.info('Transcript ingest watcher stopped');
  };
}

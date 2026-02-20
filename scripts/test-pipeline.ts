#!/usr/bin/env npx tsx
/**
 * test-pipeline.ts — End-to-end test of the Ambient AI transcript pipeline.
 *
 * Tests the full flow WITHOUT needing WhatsApp or containers:
 *   1. Drop an audio file into data/audio-inbox/
 *   2. Transcript ingest watcher detects it
 *   3. Whisper API transcribes it
 *   4. onTranscript callback fires with the text
 *   5. File moves to data/audio-processed/
 *
 * Usage:
 *   OPENAI_API_KEY=sk-proj-... npx tsx scripts/test-pipeline.ts [audio-file]
 *
 * If no audio file is provided, uses a small test .txt file to verify the
 * watcher/callback/move flow (no API key needed).
 */

import fs from 'fs';
import path from 'path';
import { startTranscriptIngest } from '../src/ambient/transcript-ingest.js';
import { splitWav, wavNeedsSplitting, getWavInfo } from '../src/ambient/wav-splitter.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const INBOX = path.join(PROJECT_ROOT, 'data/audio-inbox');
const PROCESSED = path.join(PROJECT_ROOT, 'data/audio-processed');

// Colors
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const C = '\x1b[36m';
const NC = '\x1b[0m';

function log(msg: string) {
  console.log(`${C}[test]${NC} ${msg}`);
}

function pass(msg: string) {
  console.log(`${G}  ✅ ${msg}${NC}`);
}

function fail(msg: string) {
  console.log(`${R}  ❌ ${msg}${NC}`);
}

async function main() {
  const audioFile = process.argv[2];
  const apiKey = process.env.OPENAI_API_KEY || '';

  console.log(`\n${Y}═══════════════════════════════════════════════════${NC}`);
  console.log(`${Y}  Ambient AI — Pipeline End-to-End Test${NC}`);
  console.log(`${Y}═══════════════════════════════════════════════════${NC}\n`);

  // --- Phase 1: WAV Splitter unit test ---
  log('Phase 1: WAV Splitter');

  // Create a tiny valid WAV file (44-byte header + 1000 bytes of silence)
  const testWavPath = path.join(INBOX, '_test_splitter.wav');
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + 1000, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20); // PCM
  wavHeader.writeUInt16LE(1, 22); // mono
  wavHeader.writeUInt32LE(16000, 24); // 16kHz
  wavHeader.writeUInt32LE(32000, 28); // byteRate
  wavHeader.writeUInt16LE(2, 32); // blockAlign
  wavHeader.writeUInt16LE(16, 34); // 16-bit
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(1000, 40);

  const pcmData = Buffer.alloc(1000);
  const testWav = Buffer.concat([wavHeader, pcmData]);
  fs.writeFileSync(testWavPath, testWav);

  if (!wavNeedsSplitting(testWavPath)) {
    pass('Small WAV correctly identified as not needing split');
  } else {
    fail('Small WAV incorrectly flagged for splitting');
  }

  // Test splitting with a very small max to force chunks
  const chunks = splitWav(testWavPath, 500);
  if (chunks.length > 1) {
    pass(`WAV split into ${chunks.length} chunks (forced with 500-byte max)`);
    // Verify each chunk has a valid WAV header
    let allValid = true;
    for (const chunk of chunks) {
      if (chunk.toString('ascii', 0, 4) !== 'RIFF' || chunk.toString('ascii', 8, 12) !== 'WAVE') {
        allValid = false;
      }
    }
    if (allValid) {
      pass('All chunks have valid WAV headers');
    } else {
      fail('Some chunks have invalid headers');
    }
  } else {
    fail('WAV should have been split with 500-byte max');
  }

  // Clean up test WAV
  fs.unlinkSync(testWavPath);
  pass('WAV splitter tests passed');

  // --- Phase 2: Text file flow (no API key needed) ---
  log('\nPhase 2: Text file ingest flow');

  const testFilename = `test-${Date.now()}.txt`;
  const testContent = 'This is a test transcript. The owner mentioned calling Mom on Saturday.';

  let receivedTranscript = '';
  let receivedFilename = '';

  const stop = startTranscriptIngest({
    inboxDir: INBOX,
    processedDir: PROCESSED,
    pollInterval: 1000,
    whisperModel: 'whisper-1',
    onTranscript: async (transcript, sourceFile) => {
      receivedTranscript = transcript;
      receivedFilename = sourceFile;
      log(`onTranscript fired: "${transcript.slice(0, 80)}..." from ${sourceFile}`);
    },
  });

  // Drop test file
  fs.writeFileSync(path.join(INBOX, testFilename), testContent);
  log(`Dropped ${testFilename} into inbox`);

  // Wait for processing (poll interval 1s + stability check 2s + margin)
  await new Promise((r) => setTimeout(r, 8000));

  if (receivedTranscript === testContent) {
    pass('Transcript content matches');
  } else {
    fail(`Transcript mismatch. Got: "${receivedTranscript}"`);
  }

  if (receivedFilename === testFilename) {
    pass('Source filename matches');
  } else {
    fail(`Filename mismatch. Got: "${receivedFilename}"`);
  }

  // Check file moved to processed
  const processedFiles = fs.readdirSync(PROCESSED);
  const movedFile = processedFiles.find((f) => f.endsWith(testFilename));
  if (movedFile) {
    pass(`File moved to processed: ${movedFile}`);
    // Clean up
    fs.unlinkSync(path.join(PROCESSED, movedFile));
  } else {
    fail('File not found in processed directory');
  }

  stop();

  // --- Phase 3: Audio transcription (requires API key) ---
  if (!audioFile) {
    log('\nPhase 3: Audio transcription — SKIPPED (no audio file provided)');
    log(`  Run with: OPENAI_API_KEY=sk-... npx tsx scripts/test-pipeline.ts /path/to/audio.mp3`);
  } else if (!apiKey || apiKey === 'sk-proj-...') {
    log('\nPhase 3: Audio transcription — SKIPPED (no OPENAI_API_KEY)');
    log(`  Set OPENAI_API_KEY env var and re-run`);
  } else {
    log('\nPhase 3: Audio transcription (via Whisper API)');

    const audioBasename = path.basename(audioFile);
    const ext = path.extname(audioFile).toLowerCase();

    // Show file info
    const stat = fs.statSync(audioFile);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    log(`  File: ${audioBasename} (${sizeMB}MB, ${ext})`);

    if (ext === '.wav') {
      try {
        const info = getWavInfo(audioFile);
        log(`  Duration: ~${info.durationMinutes.toFixed(1)} min`);
        log(`  Chunks needed: ${info.chunksNeeded}`);
      } catch {
        log('  (Could not parse WAV info)');
      }
    }

    let audioTranscript = '';
    let audioFilename = '';

    const stop2 = startTranscriptIngest({
      inboxDir: INBOX,
      processedDir: PROCESSED,
      pollInterval: 1000,
      openaiApiKey: apiKey,
      whisperModel: 'whisper-1',
      onTranscript: async (transcript, sourceFile) => {
        audioTranscript = transcript;
        audioFilename = sourceFile;
      },
    });

    // Copy audio file to inbox
    const inboxPath = path.join(INBOX, audioBasename);
    fs.copyFileSync(audioFile, inboxPath);
    log(`Copied ${audioBasename} to inbox`);

    // Wait for transcription (longer timeout for API call)
    log('Waiting for Whisper API transcription...');
    const maxWait = 120000; // 2 min max
    const start = Date.now();
    while (!audioTranscript && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 2000));
      process.stdout.write('.');
    }
    console.log('');

    if (audioTranscript) {
      pass(`Transcription complete (${audioTranscript.length} chars)`);
      console.log(`\n${Y}--- Transcript ---${NC}`);
      console.log(audioTranscript.slice(0, 500));
      if (audioTranscript.length > 500) console.log(`\n... (${audioTranscript.length - 500} more chars)`);
      console.log(`${Y}--- End ---${NC}\n`);

      // Check file moved
      const processed2 = fs.readdirSync(PROCESSED);
      const moved2 = processed2.find((f) => f.endsWith(audioBasename));
      if (moved2) {
        pass(`File moved to processed: ${moved2}`);
      } else {
        fail('Audio file not found in processed directory');
      }
    } else {
      fail(`Transcription timed out after ${maxWait / 1000}s`);
    }

    stop2();
  }

  console.log(`\n${Y}═══════════════════════════════════════════════════${NC}`);
  console.log(`${G}  Pipeline test complete${NC}`);
  console.log(`${Y}═══════════════════════════════════════════════════${NC}\n`);
}

main().catch((err) => {
  console.error(`${R}Fatal:${NC}`, err);
  process.exit(1);
});

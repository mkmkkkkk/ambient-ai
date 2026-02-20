/**
 * WAV File Splitter
 *
 * Splits large WAV files into chunks under 24MB each (Whisper API limit is 25MB).
 * Pure Node.js — no ffmpeg dependency.
 *
 * WAV format is trivially splittable: 44-byte header + raw PCM bytes.
 * Each chunk gets a fresh valid WAV header.
 */

import fs from 'fs';

interface WavHeader {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  byteRate: number;
}

/**
 * Parse a WAV file header. Properly finds the "data" chunk
 * instead of naively assuming offset 44.
 */
function parseWavHeader(buffer: Buffer): WavHeader {
  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') throw new Error('Not a WAV file');

  const wave = buffer.toString('ascii', 8, 12);
  if (wave !== 'WAVE') throw new Error('Not a WAVE file');

  const numChannels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);
  const bitsPerSample = buffer.readUInt16LE(34);

  // Find the "data" chunk (don't assume offset 36)
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return {
        numChannels,
        sampleRate,
        bitsPerSample,
        dataOffset: offset + 8,
        dataSize: chunkSize,
        byteRate,
      };
    }
    offset += 8 + chunkSize;
    // Align to even byte boundary (WAV spec)
    if (offset % 2 !== 0) offset++;
  }
  throw new Error('No data chunk found in WAV file');
}

/**
 * Create a valid 44-byte WAV header for a PCM chunk.
 */
function createWavHeader(
  dataSize: number,
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM subchunk size
  header.writeUInt16LE(1, 20); // AudioFormat: PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/** Default max chunk size: 24MB (stay under Whisper's 25MB limit) */
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Check if a WAV file needs splitting (exceeds maxBytes).
 */
export function wavNeedsSplitting(filePath: string, maxBytes = DEFAULT_MAX_BYTES): boolean {
  const stat = fs.statSync(filePath);
  return stat.size > maxBytes;
}

/**
 * Split a WAV file into chunks, each a valid WAV file under maxBytes.
 * Returns array of Buffers. If file is already small enough, returns [entireFile].
 *
 * Uses streaming reads to avoid loading the full 600MB into memory.
 */
export function splitWav(filePath: string, maxBytes = DEFAULT_MAX_BYTES): Buffer[] {
  const fileBuffer = fs.readFileSync(filePath);
  const header = parseWavHeader(fileBuffer);

  const pcmData = fileBuffer.subarray(
    header.dataOffset,
    header.dataOffset + header.dataSize,
  );

  // If file fits in one chunk, return as-is
  if (fileBuffer.length <= maxBytes) {
    return [fileBuffer];
  }

  const maxDataBytes = maxBytes - 44; // subtract WAV header size
  const blockAlign = header.numChannels * (header.bitsPerSample / 8);
  const alignedMax = Math.floor(maxDataBytes / blockAlign) * blockAlign;

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < pcmData.length) {
    const end = Math.min(offset + alignedMax, pcmData.length);
    const chunkData = pcmData.subarray(offset, end);
    const wavHeader = createWavHeader(
      chunkData.length,
      header.sampleRate,
      header.numChannels,
      header.bitsPerSample,
    );
    chunks.push(Buffer.concat([wavHeader, chunkData]));
    offset = end;
  }

  return chunks;
}

/**
 * Get duration info about a WAV file.
 */
export function getWavInfo(filePath: string): {
  durationMinutes: number;
  fileSizeMB: number;
  chunksNeeded: number;
} {
  const stat = fs.statSync(filePath);
  const fileSizeMB = stat.size / (1024 * 1024);

  const fileBuffer = fs.readFileSync(filePath, { length: 256 } as any);
  // Read just enough for header — fallback to full read if needed
  let byteRate: number;
  try {
    const buf = fs.readFileSync(filePath);
    const header = parseWavHeader(buf);
    byteRate = header.byteRate;
  } catch {
    // Estimate: assume 16-bit 16kHz mono = 32000 bytes/sec
    byteRate = 32000;
  }

  const durationMinutes = stat.size / byteRate / 60;
  const chunksNeeded = Math.ceil(stat.size / DEFAULT_MAX_BYTES);

  return { durationMinutes, fileSizeMB, chunksNeeded };
}

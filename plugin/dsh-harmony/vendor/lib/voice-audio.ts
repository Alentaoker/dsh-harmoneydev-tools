export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_RECORDING_MS = 90_000;

export function mergeAudioChunks(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function containsAudibleSpeech(samples: Float32Array, sampleRate: number): boolean {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  let voicedFrames = 0;
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const end = Math.min(samples.length, offset + frameSize);
    let energy = 0;
    for (let index = offset; index < end; index += 1) energy += samples[index] * samples[index];
    const rms = Math.sqrt(energy / Math.max(1, end - offset));
    if (rms >= 0.004) {
      voicedFrames += 1;
      if (voicedFrames >= 3) return true;
    }
  }
  return false;
}

export function resampleAudio(input: Float32Array, inputRate: number, outputRate = VOICE_SAMPLE_RATE): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0 || outputRate <= 0) {
    throw new Error("Invalid audio sample rate");
  }
  if (inputRate === outputRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

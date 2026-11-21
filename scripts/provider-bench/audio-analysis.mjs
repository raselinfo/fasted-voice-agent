const DEFAULT_DBFS_FLOOR = -120;
const PCM16_PEAK = 32768;

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  throw new TypeError("Expected Uint8Array or ArrayBuffer.");
}

function getInt16Sample(view, offset) {
  return view.getInt16(offset, true);
}

function amplitudeToDbfs(amplitude) {
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    return DEFAULT_DBFS_FLOOR;
  }
  return 20 * Math.log10(amplitude);
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return DEFAULT_DBFS_FLOOR;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * clampedRatio)));
  return sorted[index];
}

export function concatChunks(chunks, totalBytes) {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function encodeBase64(bytes) {
  const view = toUint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.byteLength; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary);
}

export function extractWavPcm16(bytes) {
  const viewBytes = toUint8Array(bytes);
  if (viewBytes.byteLength < 12) {
    throw new Error("WAV payload too short.");
  }

  const riff = String.fromCharCode(...viewBytes.slice(0, 4));
  const wave = String.fromCharCode(...viewBytes.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Expected RIFF/WAVE audio.");
  }

  const view = new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength);
  let offset = 12;
  let channels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let dataOffset = null;
  let dataSize = null;

  while (offset + 8 <= viewBytes.byteLength) {
    const chunkId = String.fromCharCode(...viewBytes.slice(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataSize = chunkSize;
      break;
    }

    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (!channels || !sampleRate || !bitsPerSample || dataOffset === null || dataSize === null) {
    throw new Error("Incomplete WAV metadata.");
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample}. Expected 16-bit PCM.`);
  }

  const pcmBytes = viewBytes.slice(dataOffset, Math.min(viewBytes.byteLength, dataOffset + dataSize));
  if (channels === 1) {
    return {
      pcmBytes,
      sampleRate,
      channels,
      bitsPerSample,
    };
  }

  const frameCount = Math.floor(pcmBytes.byteLength / (channels * 2));
  const pcmView = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  const mono = new Uint8Array(frameCount * 2);
  const monoView = new DataView(mono.buffer);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    let sum = 0;
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      sum += getInt16Sample(pcmView, (frameIndex * channels + channelIndex) * 2);
    }
    monoView.setInt16(frameIndex * 2, clampInt16(sum / channels), true);
  }

  return {
    pcmBytes: mono,
    sampleRate,
    channels: 1,
    bitsPerSample,
  };
}

export function createPcm16Wav(bytes, sampleRate) {
  const pcmBytes = toUint8Array(bytes);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, pcmBytes.byteLength, true);

  const wavBytes = new Uint8Array(44 + pcmBytes.byteLength);
  wavBytes.set(new Uint8Array(header), 0);
  wavBytes.set(pcmBytes, 44);
  return wavBytes;
}

export function analyzePcm16Mono(pcmBytes, sampleRate, options = {}) {
  const bytes = toUint8Array(pcmBytes);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("sampleRate must be a positive number.");
  }

  const frameMs = options.frameMs ?? 20;
  const gapMergeMs = options.gapMergeMs ?? 60;
  const noiseFloorPercentile = options.noiseFloorPercentile ?? 0.2;
  const noiseFloorMarginDb = options.noiseFloorMarginDb ?? 12;
  const minGateDbfs = options.minGateDbfs ?? -42;
  const rounded = (value) => (value === null ? null : Number(value.toFixed(2)));

  const sampleCount = Math.floor(bytes.byteLength / 2);
  const audioDurationMs = Math.round((sampleCount / sampleRate) * 1000);
  if (sampleCount === 0) {
    return {
      audioDurationMs,
      leadingSilenceMs: 0,
      speechDurationMs: 0,
      speechRmsDbfs: null,
      integratedRmsDbfs: null,
      peakDbfs: null,
      frameCount: 0,
      speechFrameCount: 0,
      noiseFloorDbfs: rounded(DEFAULT_DBFS_FLOOR),
      gateDbfs: rounded(minGateDbfs),
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.ceil(sampleCount / samplesPerFrame);
  const frameStats = [];
  let totalSumSquares = 0;
  let totalPeak = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const startSample = frameIndex * samplesPerFrame;
    const endSample = Math.min(sampleCount, startSample + samplesPerFrame);
    let sumSquares = 0;
    let peak = 0;

    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      const sample = getInt16Sample(view, sampleIndex * 2);
      const normalized = sample / PCM16_PEAK;
      const absolute = Math.abs(normalized);
      sumSquares += normalized * normalized;
      if (absolute > peak) {
        peak = absolute;
      }
    }

    totalSumSquares += sumSquares;
    if (peak > totalPeak) {
      totalPeak = peak;
    }

    const length = endSample - startSample;
    const rms = length > 0 ? Math.sqrt(sumSquares / length) : 0;
    frameStats.push({
      startSample,
      endSample,
      sumSquares,
      rmsDbfs: amplitudeToDbfs(rms),
    });
  }

  const noiseFloorDbfs = percentile(frameStats.map((frame) => frame.rmsDbfs), noiseFloorPercentile);
  const gateDbfs = Math.max(noiseFloorDbfs + noiseFloorMarginDb, minGateDbfs);
  const activeFrames = frameStats.map((frame) => frame.rmsDbfs >= gateDbfs);
  const maxGapFrames = Math.max(0, Math.round(gapMergeMs / frameMs));

  let lastActiveIndex = -1;
  for (let frameIndex = 0; frameIndex < activeFrames.length; frameIndex += 1) {
    if (!activeFrames[frameIndex]) {
      continue;
    }
    if (lastActiveIndex >= 0) {
      const gapFrames = frameIndex - lastActiveIndex - 1;
      if (gapFrames > 0 && gapFrames <= maxGapFrames) {
        for (let fillIndex = lastActiveIndex + 1; fillIndex < frameIndex; fillIndex += 1) {
          activeFrames[fillIndex] = true;
        }
      }
    }
    lastActiveIndex = frameIndex;
  }

  let firstActiveFrameIndex = null;
  let speechFrameCount = 0;
  let speechSampleCount = 0;
  let speechSumSquares = 0;

  for (let frameIndex = 0; frameIndex < activeFrames.length; frameIndex += 1) {
    if (!activeFrames[frameIndex]) {
      continue;
    }
    if (firstActiveFrameIndex === null) {
      firstActiveFrameIndex = frameIndex;
    }
    speechFrameCount += 1;
    speechSampleCount += frameStats[frameIndex].endSample - frameStats[frameIndex].startSample;
    speechSumSquares += frameStats[frameIndex].sumSquares;
  }

  const integratedRmsDbfs = totalSumSquares > 0
    ? amplitudeToDbfs(Math.sqrt(totalSumSquares / sampleCount))
    : null;
  const speechRmsDbfs = speechSampleCount > 0
    ? amplitudeToDbfs(Math.sqrt(speechSumSquares / speechSampleCount))
    : null;
  const leadingSilenceMs = firstActiveFrameIndex === null
    ? audioDurationMs
    : Math.round((frameStats[firstActiveFrameIndex].startSample / sampleRate) * 1000);
  const speechDurationMs = Math.round((speechSampleCount / sampleRate) * 1000);

  return {
    audioDurationMs,
    leadingSilenceMs,
    speechDurationMs,
    speechRmsDbfs: rounded(speechRmsDbfs),
    integratedRmsDbfs: rounded(integratedRmsDbfs),
    peakDbfs: rounded(amplitudeToDbfs(totalPeak)),
    frameCount,
    speechFrameCount,
    noiseFloorDbfs: rounded(noiseFloorDbfs),
    gateDbfs: rounded(gateDbfs),
  };
}

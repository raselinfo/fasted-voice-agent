import { Pcm16GainProcessor, applyPcm16Gain } from "./pcm-gain";
import type { WorkersAiBinding } from "../providers/contracts";

const AURA_MODEL = "@cf/deepgram/aura-2-en";
const AURA_ENCODING = "linear16";
const AURA_CONTAINER = "wav";
export const AURA_SAMPLE_RATE = 16000;
const AURA_SPEAKER = "luna";
export const AURA_DEFAULT_MODEL = AURA_MODEL;
const AURA_LEADING_TRIM_THRESHOLD = 256;
const AURA_MAX_LEADING_TRIM_BYTES = 16000;

type WorkersAiAuraStreamOptions = {
  ai: WorkersAiBinding | undefined;
  onAudioChunk: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
  model?: string;
  speaker?: string;
  gainDb?: number;
};

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value && value.byteLength > 0) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

type WavParserState = {
  pending: Uint8Array;
  dataOffset: number | null;
};

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function findLeadingSpeechOffset(pcmBytes: Uint8Array, threshold: number): number | null {
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  for (let offset = 0; offset + 1 < pcmBytes.byteLength; offset += 2) {
    const sample = Math.abs(view.getInt16(offset, true));
    if (sample > threshold) {
      return offset;
    }
  }

  return null;
}

function logLeadingTrim(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event: "tts.leading_trim",
      ts: new Date().toISOString(),
      provider: "workers-ai-aura",
      ...fields,
    }),
  );
}

function parseWavDataOffset(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) {
    return null;
  }

  const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  const wave = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Workers AI Aura response was not a WAV stream.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (chunkId === "data") {
      return bodyOffset;
    }
    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  return null;
}

function takePcmChunk(state: WavParserState, chunk: Uint8Array): Uint8Array | null {
  if (state.dataOffset !== null) {
    return chunk.byteLength > 0 ? chunk : null;
  }

  state.pending = concatBytes(state.pending, chunk);
  const dataOffset = parseWavDataOffset(state.pending);
  if (dataOffset === null) {
    return null;
  }

  state.dataOffset = dataOffset;
  const pcm = state.pending.slice(dataOffset);
  state.pending = new Uint8Array(0);
  return pcm.byteLength > 0 ? pcm : null;
}

export class WorkersAiAuraTtsStream {
  private readonly ai: WorkersAiBinding | undefined;
  private readonly onAudioChunk: (chunk: Uint8Array) => void;
  private readonly onError?: (error: Error) => void;
  private readonly model: string;
  private readonly speaker: string;
  private readonly gainDb: number;
  private readonly gainProcessor: Pcm16GainProcessor;
  private leadingTrimPending = true;
  private leadingTrimBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private closed = false;
  private abortRequested = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WorkersAiAuraStreamOptions) {
    this.ai = options.ai;
    this.onAudioChunk = options.onAudioChunk;
    this.onError = options.onError;
    this.model = options.model ?? AURA_MODEL;
    this.speaker = options.speaker ?? AURA_SPEAKER;
    this.gainDb = options.gainDb ?? 0;
    this.gainProcessor = new Pcm16GainProcessor(this.gainDb);
  }

  async connect(): Promise<void> {
    if (!this.ai || typeof this.ai.run !== "function") {
      throw new Error("Missing Workers AI binding.");
    }
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed) {
      return;
    }

    this.queue = this.queue.then(async () => {
      if (this.closed) {
        throw this.abortRequested ? createAbortError() : new Error("Aura stream closed.");
      }

      let response: Response | undefined;
      // Occasional upstream flake returns a response without a body; one retry
      // after a short backoff recovers without user-visible failure.
      for (let attempt = 0; attempt < 2; attempt++) {
        response = (await this.ai?.run(
          this.model,
          {
            text: trimmed,
            speaker: this.speaker,
            encoding: AURA_ENCODING,
            container: AURA_CONTAINER,
            sample_rate: AURA_SAMPLE_RATE,
          },
          {
            returnRawResponse: true,
          },
        )) as Response | undefined;
        if (response?.body || this.closed) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }

      if (!response?.body) {
        throw new Error(`Workers AI Aura response missing body for ${this.model}.`);
      }

      const wavState: WavParserState = {
        pending: new Uint8Array(0),
        dataOffset: null,
      };

      for await (const chunk of readBody(response.body)) {
        if (this.closed) {
          throw this.abortRequested ? createAbortError() : new Error("Aura stream closed.");
        }
        const pcmChunk = takePcmChunk(wavState, new Uint8Array(chunk));
        if (pcmChunk) {
          this.emitAudioChunk(pcmChunk);
        }
      }
    }).catch((error: unknown) => {
      if (isAbortError(error)) {
        throw error;
      }
      const wrapped = error instanceof Error ? error : new Error(String(error));
      this.onError?.(wrapped);
      throw wrapped;
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  close(aborted = false): void {
    this.closed = true;
    this.abortRequested = aborted;
  }

  private emitAudioChunk(chunk: Uint8Array): void {
    const gainedChunk = this.gainProcessor.process(chunk);
    if (gainedChunk.byteLength === 0) {
      return;
    }

    if (!this.leadingTrimPending) {
      this.onAudioChunk(gainedChunk);
      return;
    }

    this.leadingTrimBuffer = concatBytes(this.leadingTrimBuffer, gainedChunk);
    const speechOffset = findLeadingSpeechOffset(this.leadingTrimBuffer, AURA_LEADING_TRIM_THRESHOLD);
    if (speechOffset !== null) {
      const trimmedChunk = this.leadingTrimBuffer.slice(speechOffset);
      logLeadingTrim({
        outcome: "applied",
        trimmedBytes: speechOffset,
        trimmedMs: Math.round(speechOffset / 32),
        threshold: AURA_LEADING_TRIM_THRESHOLD,
        sampleRate: AURA_SAMPLE_RATE,
      });
      this.leadingTrimPending = false;
      this.leadingTrimBuffer = new Uint8Array(0);
      if (trimmedChunk.byteLength > 0) {
        this.onAudioChunk(trimmedChunk);
      }
      return;
    }

    if (this.leadingTrimBuffer.byteLength >= AURA_MAX_LEADING_TRIM_BYTES) {
      logLeadingTrim({
        outcome: "bypassed",
        reason: "max_window_reached",
        bufferedBytes: this.leadingTrimBuffer.byteLength,
        bufferedMs: Math.round(this.leadingTrimBuffer.byteLength / 32),
        threshold: AURA_LEADING_TRIM_THRESHOLD,
        sampleRate: AURA_SAMPLE_RATE,
      });
      this.leadingTrimPending = false;
      const bufferedChunk = this.leadingTrimBuffer;
      this.leadingTrimBuffer = new Uint8Array(0);
      if (bufferedChunk.byteLength > 0) {
        this.onAudioChunk(bufferedChunk);
      }
    }
  }
}

export const __test__ = {
  Pcm16GainProcessor,
  applyPcm16Gain,
  findLeadingSpeechOffset,
  parseWavDataOffset,
  takePcmChunk,
};

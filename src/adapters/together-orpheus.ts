import { Pcm16GainProcessor, applyPcm16Gain } from "./pcm-gain";

const TOGETHER_TTS_URL = "https://api.together.ai/v1/audio/speech";
const TOGETHER_ORPHEUS_MODEL = "canopylabs/orpheus-3b-0.1-ft";
const TOGETHER_ORPHEUS_VOICE = "leo";
export const TOGETHER_ORPHEUS_SAMPLE_RATE = 24000;
export const TOGETHER_ORPHEUS_DEFAULT_MODEL = TOGETHER_ORPHEUS_MODEL;
const TOGETHER_LEADING_TRIM_THRESHOLD = 256;
const TOGETHER_MAX_LEADING_TRIM_BYTES = 24000;

type TogetherOrpheusStreamOptions = {
  apiKey: string | undefined;
  onAudioChunk: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
  model?: string;
  voice?: string;
  gainDb?: number;
};

type TogetherEvent = {
  type?: string;
  delta?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("No base64 decoder available.");
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function sliceBytes(bytes: Uint8Array, start: number): Uint8Array {
  const sliced = bytes.slice(start);
  return new Uint8Array(sliced);
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

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function logLeadingTrim(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event: "tts.leading_trim",
      ts: new Date().toISOString(),
      provider: "together-orpheus",
      ...fields,
    }),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parseTogetherEvent(payload: string): TogetherEvent | null {
  try {
    return JSON.parse(payload) as TogetherEvent;
  } catch {
    return null;
  }
}

function splitSseFrames(buffer: string): { frames: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  return { frames, remainder };
}

function parseSseData(frame: string): string[] {
  const payloads: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      payloads.push(line.slice(5).trim());
    }
  }
  return payloads;
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TogetherEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      pending += decoder.decode(value, { stream: true });
      const { frames, remainder } = splitSseFrames(pending);
      pending = remainder;

      for (const frame of frames) {
        for (const data of parseSseData(frame)) {
          if (!data || data === "[DONE]") {
            continue;
          }
          const parsed = parseTogetherEvent(data);
          if (parsed) {
            onEvent(parsed);
          }
        }
      }
    }

    pending += decoder.decode();
    const { frames } = splitSseFrames(pending + "\n\n");
    for (const frame of frames) {
      for (const data of parseSseData(frame)) {
        if (!data || data === "[DONE]") {
          continue;
        }
        const parsed = parseTogetherEvent(data);
        if (parsed) {
          onEvent(parsed);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class TogetherOrpheusTtsStream {
  private readonly apiKey: string | undefined;
  private readonly onAudioChunk: (chunk: Uint8Array) => void;
  private readonly onError?: (error: Error) => void;
  private readonly model: string;
  private readonly voice: string;
  private readonly gainDb: number;
  private readonly gainProcessor: Pcm16GainProcessor;
  private leadingTrimPending = true;
  private leadingTrimBuffer = new Uint8Array(0);
  private closed = false;
  private abortRequested = false;
  private activeAbort: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastError: unknown = null;

  constructor(options: TogetherOrpheusStreamOptions) {
    this.apiKey = options.apiKey;
    this.onAudioChunk = options.onAudioChunk;
    this.onError = options.onError;
    this.model = options.model ?? TOGETHER_ORPHEUS_MODEL;
    this.voice = options.voice ?? TOGETHER_ORPHEUS_VOICE;
    this.gainDb = options.gainDb ?? 0;
    this.gainProcessor = new Pcm16GainProcessor(this.gainDb);
  }

  async connect(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("Missing TOGETHER_API_KEY.");
    }
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed) {
      return;
    }

    this.queue = this.queue.then(async () => {
      if (this.closed) {
        throw this.abortRequested ? createAbortError() : new Error("Together stream closed.");
      }

      const abortController = new AbortController();
      this.activeAbort = abortController;

      try {
        const response = await fetch(TOGETHER_TTS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            input: trimmed,
            voice: this.voice,
            response_format: "raw",
            response_encoding: "pcm_s16le",
            sample_rate: TOGETHER_ORPHEUS_SAMPLE_RATE,
            stream: true,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Together TTS request failed with status ${response.status}.`);
        }
        if (!response.body) {
          throw new Error("Together TTS response missing body.");
        }

        await readSseStream(response.body, (event) => {
          if (event.type === "conversation.item.audio_output.delta" && event.delta) {
            this.emitAudioChunk(decodeBase64(event.delta));
            return;
          }

          if (event.type === "conversation.item.tts.failed") {
            throw new Error(event.error?.message ?? "Together Orpheus synthesis failed.");
          }
        });
      } finally {
        if (this.activeAbort === abortController) {
          this.activeAbort = null;
        }
      }
    }).catch((error: unknown) => {
      this.lastError = error;
      if (isAbortError(error)) {
        return;
      }
      const wrapped = error instanceof Error ? error : new Error(String(error));
      this.onError?.(wrapped);
      throw wrapped;
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.lastError) {
      const error = this.lastError;
      this.lastError = null;
      throw error;
    }
  }

  close(aborted = false): void {
    this.closed = true;
    this.abortRequested = aborted;
    if (aborted) {
      this.activeAbort?.abort();
    }
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

    const merged = concatBytes(this.leadingTrimBuffer, gainedChunk);
    this.leadingTrimBuffer = new Uint8Array(merged);
    const offset = findLeadingSpeechOffset(this.leadingTrimBuffer, TOGETHER_LEADING_TRIM_THRESHOLD);
    if (offset !== null) {
      const trimmed = sliceBytes(this.leadingTrimBuffer, offset);
      logLeadingTrim({
        outcome: "applied",
        trimmedBytes: offset,
        trimmedMs: Math.round(offset / 48),
        threshold: TOGETHER_LEADING_TRIM_THRESHOLD,
        sampleRate: TOGETHER_ORPHEUS_SAMPLE_RATE,
      });
      if (trimmed.byteLength > 0) {
        this.onAudioChunk(trimmed);
      }
      this.leadingTrimBuffer = new Uint8Array(0);
      this.leadingTrimPending = false;
      return;
    }

    if (this.leadingTrimBuffer.byteLength >= TOGETHER_MAX_LEADING_TRIM_BYTES) {
      logLeadingTrim({
        outcome: "bypassed",
        reason: "max_window_reached",
        bufferedBytes: this.leadingTrimBuffer.byteLength,
        bufferedMs: Math.round(this.leadingTrimBuffer.byteLength / 48),
        threshold: TOGETHER_LEADING_TRIM_THRESHOLD,
        sampleRate: TOGETHER_ORPHEUS_SAMPLE_RATE,
      });
      this.onAudioChunk(this.leadingTrimBuffer);
      this.leadingTrimBuffer = new Uint8Array(0);
      this.leadingTrimPending = false;
    }
  }
}

export const __test__ = {
  applyPcm16Gain,
  concatBytes,
  decodeBase64,
  findLeadingSpeechOffset,
  sliceBytes,
  parseTogetherEvent,
  parseSseData,
  splitSseFrames,
};

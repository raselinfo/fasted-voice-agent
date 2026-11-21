import type { WorkersAiBinding } from "../providers/contracts";
import type {
  FluxEagerEndOfTurnCallback,
  FluxEndOfTurnCallback,
  FluxStartOfTurnCallback,
  FluxTurnResumedCallback,
} from "./deepgram-flux";

export type WorkersAiFluxBridgeOptions = {
  ai: WorkersAiBinding;
  onStartOfTurn: FluxStartOfTurnCallback;
  onEagerEndOfTurn?: FluxEagerEndOfTurnCallback;
  onEndOfTurn: FluxEndOfTurnCallback;
  onTurnResumed?: FluxTurnResumedCallback;
  onError?: (error: Error) => void;
  model?: string;
  encoding?: string;
  sampleRate?: number;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
};

type FluxEventMessage = {
  event?: string;
  transcript?: string;
};

type WorkersAiFluxResponse = {
  webSocket?: WebSocket | null;
};

const DEFAULT_MODEL = "@cf/deepgram/flux";
const DEFAULT_ENCODING = "linear16";
const DEFAULT_SAMPLE_RATE = 16000;

function decodeSocketMessage(rawData: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof rawData === "string") {
    return rawData;
  }

  if (rawData instanceof ArrayBuffer) {
    return new TextDecoder().decode(rawData);
  }

  if (ArrayBuffer.isView(rawData)) {
    return new TextDecoder().decode(new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength));
  }

  return "";
}

export class WorkersAiFluxBridge {
  private readonly ai: WorkersAiBinding;
  private readonly onStartOfTurn: FluxStartOfTurnCallback;
  private readonly onEagerEndOfTurn?: FluxEagerEndOfTurnCallback;
  private readonly onEndOfTurn: FluxEndOfTurnCallback;
  private readonly onTurnResumed?: FluxTurnResumedCallback;
  private readonly onError?: (error: Error) => void;
  private readonly model: string;
  private readonly encoding: string;
  private readonly sampleRate: number;
  private readonly eotThreshold?: number;
  private readonly eagerEotThreshold?: number;
  private readonly eotTimeoutMs?: number;
  private socket: WebSocket | null = null;

  constructor(options: WorkersAiFluxBridgeOptions) {
    this.ai = options.ai;
    this.onStartOfTurn = options.onStartOfTurn;
    this.onEagerEndOfTurn = options.onEagerEndOfTurn;
    this.onEndOfTurn = options.onEndOfTurn;
    this.onTurnResumed = options.onTurnResumed;
    this.onError = options.onError;
    this.model = options.model ?? DEFAULT_MODEL;
    this.encoding = options.encoding ?? DEFAULT_ENCODING;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.eotThreshold = options.eotThreshold;
    this.eagerEotThreshold = options.eagerEotThreshold;
    this.eotTimeoutMs = options.eotTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    let response: WorkersAiFluxResponse | undefined;
    try {
      response = (await this.ai.run(
        this.model,
        {
          encoding: this.encoding,
          sample_rate: String(this.sampleRate),
          ...(typeof this.eotThreshold === "number" ? { eot_threshold: String(this.eotThreshold) } : {}),
          ...(typeof this.eagerEotThreshold === "number"
            ? { eager_eot_threshold: String(this.eagerEotThreshold) }
            : {}),
          ...(typeof this.eotTimeoutMs === "number" ? { eot_timeout_ms: String(this.eotTimeoutMs) } : {}),
        },
        { websocket: true },
      )) as WorkersAiFluxResponse | undefined;
    } catch (error) {
      const detail =
        error instanceof Error && error.message.length > 0
          ? error.message
          : JSON.stringify(error).slice(0, 500);
      throw new Error(`Workers AI Flux connect failed (${this.model}): ${detail}`);
    }

    const socket = response?.webSocket;
    if (!socket) {
      throw new Error("Workers AI Flux websocket upgrade failed.");
    }

    socket.accept();
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.socket = null;
    });
    socket.addEventListener("error", () => {
      this.reportError(new Error("Workers AI Flux websocket error."));
    });

    this.socket = socket;
  }

  sendAudioChunk(chunk: ArrayBuffer | Uint8Array): void {
    const payload = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.socket?.send(payload);
  }

  close(): void {
    try {
      this.socket?.close(1000, "session_closed");
    } catch {
      // Ignore close races.
    }
    this.socket = null;
  }

  private handleMessage(rawData: string | ArrayBuffer | ArrayBufferView): void {
    const payloadText = decodeSocketMessage(rawData);
    if (!payloadText) {
      return;
    }

    let parsed: FluxEventMessage;
    try {
      parsed = JSON.parse(payloadText) as FluxEventMessage;
    } catch {
      return;
    }

    if (parsed.event === "StartOfTurn") {
      this.onStartOfTurn(parsed.transcript?.trim() || undefined);
      return;
    }

    if (parsed.event === "EagerEndOfTurn") {
      const transcript = parsed.transcript?.trim();
      if (transcript) {
        void this.onEagerEndOfTurn?.(transcript);
      }
      return;
    }

    if (parsed.event === "TurnResumed") {
      this.onTurnResumed?.();
      return;
    }

    if (parsed.event === "EndOfTurn") {
      const finalTranscript = parsed.transcript?.trim();
      if (finalTranscript) {
        void this.onEndOfTurn(finalTranscript);
      }
    }
  }

  private reportError(error: Error): void {
    this.onError?.(error);
  }
}

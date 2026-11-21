export type FluxStartOfTurnCallback = (transcriptHint?: string) => void;
export type FluxEagerEndOfTurnCallback = (transcript: string) => void | Promise<void>;
export type FluxEndOfTurnCallback = (finalTranscript: string) => void | Promise<void>;
export type FluxTurnResumedCallback = () => void;

export type DeepgramFluxBridgeOptions = {
  apiKey: string;
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

const DEFAULT_MODEL = "flux-general-en";
const DEFAULT_ENCODING = "linear16";
const DEFAULT_SAMPLE_RATE = 16000;

export class DeepgramFluxBridge {
  private readonly apiKey: string;
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

  constructor(options: DeepgramFluxBridgeOptions) {
    this.apiKey = options.apiKey;
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

    const url = new URL("https://api.deepgram.com/v2/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", this.encoding);
    url.searchParams.set("sample_rate", String(this.sampleRate));
    if (typeof this.eotThreshold === "number") {
      url.searchParams.set("eot_threshold", String(this.eotThreshold));
    }
    if (typeof this.eagerEotThreshold === "number") {
      url.searchParams.set("eager_eot_threshold", String(this.eagerEotThreshold));
    }
    if (typeof this.eotTimeoutMs === "number") {
      url.searchParams.set("eot_timeout_ms", String(this.eotTimeoutMs));
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Upgrade: "websocket",
      },
    });

    const socket = response.webSocket;
    if (!socket) {
      throw new Error(`Deepgram Flux websocket upgrade failed with status ${response.status}`);
    }

    socket.accept();
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.socket = null;
    });
    socket.addEventListener("error", () => {
      this.reportError(new Error("Deepgram Flux websocket error."));
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
    let payloadText = "";
    if (typeof rawData === "string") {
      payloadText = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      payloadText = new TextDecoder().decode(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      payloadText = new TextDecoder().decode(rawData.buffer);
    } else {
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

    if (parsed.event === "EndOfTurn") {
      const finalTranscript = parsed.transcript?.trim();
      if (finalTranscript) {
        void this.onEndOfTurn(finalTranscript);
      }
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
    }
  }

  private reportError(error: Error): void {
    this.onError?.(error);
  }
}

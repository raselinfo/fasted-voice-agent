export type SessionState =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export const SESSION_STATE_SEQUENCE = [
  "idle",
  "requesting_mic",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "interrupted",
  "error",
] as const satisfies readonly SessionState[];

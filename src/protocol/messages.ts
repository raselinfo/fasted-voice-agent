import { z } from "zod";

import { SESSION_STATE_SEQUENCE } from "../durable/session-state";
import { resolveTtsProvider } from "../providers/contracts";

export const CLIENT_AUDIO_ENCODING = "pcm16";
export const CLIENT_AUDIO_CHANNELS = 1;
export const ASSISTANT_AUDIO_ENCODING = "pcm16";
export const ASSISTANT_AUDIO_CHANNELS = 1;
export const DEFAULT_ASSISTANT_AUDIO_SAMPLE_RATE = 16000;
export const SESSION_SCENARIOS = ["drive-thru", "restaurant-booking", "customer-support"] as const;
export type SessionScenario = (typeof SESSION_SCENARIOS)[number];

export type SessionStartMessage = {
  type: "session.start";
  sessionId: string;
  analytics?: {
    distinctId?: string;
    sessionId?: string;
  };
  sampleRate: number;
  audioFormat: {
    encoding: typeof CLIENT_AUDIO_ENCODING;
    channels: typeof CLIENT_AUDIO_CHANNELS;
  };
  scenario?: SessionScenario;
  ttsConfig?: {
    provider?: "elevenlabs" | "workers-ai-aura" | "together-orpheus";
    model?: string;
    voice?: string;
  };
  demoOverrides?: {
    systemPrompt?: string;
    disabledTools?: string[];
  };
};

export type ClientInterruptMessage = {
  type: "client.interrupt";
};

export type AssistantPlaybackStartedMessage = {
  type: "turn.assistant.playback.started";
  assistantTurnId: number;
  clientTsMs?: number;
};

export type AssistantPlaybackEndedMessage = {
  type: "turn.assistant.playback.ended";
  assistantTurnId: number;
  clientTsMs?: number;
};

export type AssistantAudioStartReceivedMessage = {
  type: "turn.assistant.audio.start.received";
  assistantTurnId: number;
  clientTsMs?: number;
};

export type SessionStopMessage = {
  type: "session.stop";
};

export type ClientMessage =
  | SessionStartMessage
  | ClientInterruptMessage
  | AssistantPlaybackStartedMessage
  | AssistantPlaybackEndedMessage
  | AssistantAudioStartReceivedMessage
  | SessionStopMessage;

export type SessionReadyMessage = {
  type: "session.ready";
  sessionId: string;
};

export type SessionStateMessage = {
  type: "session.state";
  state: (typeof SESSION_STATE_SEQUENCE)[number];
};

export type SessionErrorMessage = {
  type: "session.error";
  code: string;
  message: string;
};

export type SessionClosedMessage = {
  type: "session.closed";
  reason: string;
};

export type UserTurnFinalMessage = {
  type: "turn.user.final";
  turnId: number;
  text: string;
};

export type AssistantTurnFinalMessage = {
  type: "turn.assistant.final";
  assistantTurnId: number;
  text: string;
};

export type AssistantTurnAudioStartMessage = {
  type: "turn.assistant.audio.start";
  assistantTurnId: number;
  sampleRate: number;
  encoding: typeof ASSISTANT_AUDIO_ENCODING;
  channels: typeof ASSISTANT_AUDIO_CHANNELS;
};

export type AssistantTurnAudioEndMessage = {
  type: "turn.assistant.audio.end";
  assistantTurnId: number;
  isFinal: boolean;
};

export type TurnInterruptedMessage = {
  type: "turn.interrupted";
  assistantTurnId: number;
  reason: "start_of_turn" | "client_hint";
};

export type BackgroundTurnUpdateMessage = {
  type: "background.turn.update";
  turnId: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  summary: string;
  updatedAt: string;
  actions?: Array<{ tool: string; ok: boolean; output?: unknown; error?: string }>;
};

export type TurnTraceMessage = {
  type: "turn.trace";
  assistantTurnId: number;
  marksFromEndOfTurnMs: Partial<Record<string, number>>;
};

export type ServerMessage =
  | SessionReadyMessage
  | SessionStateMessage
  | SessionErrorMessage
  | SessionClosedMessage
  | UserTurnFinalMessage
  | AssistantTurnFinalMessage
  | AssistantTurnAudioStartMessage
  | AssistantTurnAudioEndMessage
  | TurnInterruptedMessage
  | BackgroundTurnUpdateMessage
  | TurnTraceMessage;

export const sessionStartMessageSchema = z.object({
  type: z.literal("session.start"),
  sessionId: z.string().min(1),
  analytics: z
    .object({
      distinctId: z.string().trim().min(1).optional(),
      sessionId: z.string().trim().min(1).optional(),
    })
    .optional(),
  sampleRate: z.number().int().positive(),
  audioFormat: z.object({
    encoding: z.literal(CLIENT_AUDIO_ENCODING),
    channels: z.literal(CLIENT_AUDIO_CHANNELS),
  }),
  scenario: z.enum(SESSION_SCENARIOS).optional(),
  ttsConfig: z
    .object({
      provider: z
        .string()
        .transform((value) => resolveTtsProvider(value))
        .optional(),
      model: z.string().trim().min(1).optional(),
      voice: z.string().trim().min(1).optional(),
    })
    .optional(),
  demoOverrides: z
    .object({
      systemPrompt: z.string().trim().min(1).optional(),
      disabledTools: z.array(z.string().trim().min(1)).optional(),
    })
    .optional(),
});

export const clientInterruptMessageSchema = z.object({
  type: z.literal("client.interrupt"),
});

export const assistantPlaybackStartedMessageSchema = z.object({
  type: z.literal("turn.assistant.playback.started"),
  assistantTurnId: z.number().int().positive(),
  clientTsMs: z.number().int().optional(),
});

export const assistantPlaybackEndedMessageSchema = z.object({
  type: z.literal("turn.assistant.playback.ended"),
  assistantTurnId: z.number().int().positive(),
  clientTsMs: z.number().int().optional(),
});

export const assistantAudioStartReceivedMessageSchema = z.object({
  type: z.literal("turn.assistant.audio.start.received"),
  assistantTurnId: z.number().int().positive(),
  clientTsMs: z.number().int().optional(),
});

export const sessionStopMessageSchema = z.object({
  type: z.literal("session.stop"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  sessionStartMessageSchema,
  clientInterruptMessageSchema,
  assistantPlaybackStartedMessageSchema,
  assistantPlaybackEndedMessageSchema,
  assistantAudioStartReceivedMessageSchema,
  sessionStopMessageSchema,
]);

export const sessionReadyMessageSchema = z.object({
  type: z.literal("session.ready"),
  sessionId: z.string().min(1),
});

export const sessionStateMessageSchema = z.object({
  type: z.literal("session.state"),
  state: z.enum(SESSION_STATE_SEQUENCE),
});

export const sessionErrorMessageSchema = z.object({
  type: z.literal("session.error"),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const sessionClosedMessageSchema = z.object({
  type: z.literal("session.closed"),
  reason: z.string().min(1),
});

export const userTurnFinalMessageSchema = z.object({
  type: z.literal("turn.user.final"),
  turnId: z.number().int().positive(),
  text: z.string().min(1),
});

export const assistantTurnFinalMessageSchema = z.object({
  type: z.literal("turn.assistant.final"),
  assistantTurnId: z.number().int().positive(),
  text: z.string().min(1),
});

export const assistantTurnAudioStartMessageSchema = z.object({
  type: z.literal("turn.assistant.audio.start"),
  assistantTurnId: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  encoding: z.literal(ASSISTANT_AUDIO_ENCODING),
  channels: z.literal(ASSISTANT_AUDIO_CHANNELS),
});

export const assistantTurnAudioEndMessageSchema = z.object({
  type: z.literal("turn.assistant.audio.end"),
  assistantTurnId: z.number().int().positive(),
  isFinal: z.boolean(),
});

export const turnInterruptedMessageSchema = z.object({
  type: z.literal("turn.interrupted"),
  assistantTurnId: z.number().int().positive(),
  reason: z.enum(["start_of_turn", "client_hint"]),
});

export const backgroundTurnUpdateMessageSchema = z.object({
  type: z.literal("background.turn.update"),
  turnId: z.number().int().positive(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  summary: z.string().min(1),
  updatedAt: z.string().min(1),
  actions: z
    .array(
      z.object({
        tool: z.string().min(1),
        ok: z.boolean(),
        output: z.unknown().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});

export const turnTraceMessageSchema = z.object({
  type: z.literal("turn.trace"),
  assistantTurnId: z.number().int().positive(),
  marksFromEndOfTurnMs: z.record(z.string(), z.number()),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  sessionReadyMessageSchema,
  sessionStateMessageSchema,
  sessionErrorMessageSchema,
  sessionClosedMessageSchema,
  userTurnFinalMessageSchema,
  assistantTurnFinalMessageSchema,
  assistantTurnAudioStartMessageSchema,
  assistantTurnAudioEndMessageSchema,
  turnInterruptedMessageSchema,
  backgroundTurnUpdateMessageSchema,
  turnTraceMessageSchema,
]);

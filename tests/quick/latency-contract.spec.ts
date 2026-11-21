import { describe, expect, it } from "vitest";

import {
  assistantAudioStartReceivedMessageSchema,
  assistantPlaybackEndedMessageSchema,
  assistantPlaybackStartedMessageSchema,
  assistantTurnAudioEndMessageSchema,
  assistantTurnAudioStartMessageSchema,
  clientMessageSchema,
  sessionStartMessageSchema,
} from "../../src/protocol/messages";

describe("Quick latency contract", () => {
  it("LAT-01 accepts negotiated session.start with real browser sample rate and rejects legacy audio.chunk payloads", () => {
    expect(
      sessionStartMessageSchema.parse({
        type: "session.start",
        sessionId: "session-1",
        sampleRate: 48000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
      }),
    ).toEqual({
      type: "session.start",
      sessionId: "session-1",
      sampleRate: 48000,
      audioFormat: {
        encoding: "pcm16",
        channels: 1,
      },
    });

    expect(() =>
      clientMessageSchema.parse({
        type: "audio.chunk",
        sequence: 0,
        sampleRate: 16000,
        encoding: "pcm16",
        payloadBase64: "AQID",
      }),
    ).toThrow();
  });

  it("LAT-02 accepts streamed assistant audio lifecycle control messages", () => {
    expect(
      assistantTurnAudioStartMessageSchema.parse({
        type: "turn.assistant.audio.start",
        assistantTurnId: 3,
        sampleRate: 16000,
        encoding: "pcm16",
        channels: 1,
      }),
    ).toEqual({
      type: "turn.assistant.audio.start",
      assistantTurnId: 3,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });

    expect(
      assistantTurnAudioEndMessageSchema.parse({
        type: "turn.assistant.audio.end",
        assistantTurnId: 3,
        isFinal: true,
      }),
    ).toEqual({
      type: "turn.assistant.audio.end",
      assistantTurnId: 3,
      isFinal: true,
    });
  });

  it("LAT-03 keeps binary media frames outside the JSON contract", () => {
    const start = assistantTurnAudioStartMessageSchema.parse({
      type: "turn.assistant.audio.start",
      assistantTurnId: 5,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    const end = assistantTurnAudioEndMessageSchema.parse({
      type: "turn.assistant.audio.end",
      assistantTurnId: 5,
      isFinal: true,
    });

    expect(start.type).toBe("turn.assistant.audio.start");
    expect(end.type).toBe("turn.assistant.audio.end");
    expect("audioBase64" in start).toBe(false);
    expect("payloadBase64" in start).toBe(false);
  });

  it("LAT-04 accepts the browser playback-start control message", () => {
    expect(
      assistantPlaybackStartedMessageSchema.parse({
        type: "turn.assistant.playback.started",
        assistantTurnId: 5,
        clientTsMs: 1_717_000_000_000,
      }),
    ).toEqual({
      type: "turn.assistant.playback.started",
      assistantTurnId: 5,
      clientTsMs: 1_717_000_000_000,
    });

    expect(
      clientMessageSchema.parse({
        type: "turn.assistant.playback.started",
        assistantTurnId: 5,
      }),
    ).toEqual({
      type: "turn.assistant.playback.started",
      assistantTurnId: 5,
    });

    expect(
      assistantAudioStartReceivedMessageSchema.parse({
        type: "turn.assistant.audio.start.received",
        assistantTurnId: 5,
        clientTsMs: 1_717_000_000_250,
      }),
    ).toEqual({
      type: "turn.assistant.audio.start.received",
      assistantTurnId: 5,
      clientTsMs: 1_717_000_000_250,
    });

    expect(
      clientMessageSchema.parse({
        type: "turn.assistant.audio.start.received",
        assistantTurnId: 5,
      }),
    ).toEqual({
      type: "turn.assistant.audio.start.received",
      assistantTurnId: 5,
    });
  });

  it("LAT-05 accepts the browser playback-end control message", () => {
    expect(
      assistantPlaybackEndedMessageSchema.parse({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 5,
        clientTsMs: 1_717_000_000_500,
      }),
    ).toEqual({
      type: "turn.assistant.playback.ended",
      assistantTurnId: 5,
      clientTsMs: 1_717_000_000_500,
    });

    expect(
      clientMessageSchema.parse({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 5,
      }),
    ).toEqual({
      type: "turn.assistant.playback.ended",
      assistantTurnId: 5,
    });
  });
});

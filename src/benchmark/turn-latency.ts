import type { ProviderLabels } from "../providers/contracts";

export type TurnLatencyMilestone =
  | "eagerEndOfTurn"
  | "endOfTurn"
  | "llmRequestStarted"
  | "firstText"
  | "llmDone"
  | "ttsReady"
  | "firstChunkSentToTts"
  | "firstAudioGenerated"
  | "audioStartSent"
  | "firstAudioChunkSent"
  | "ttsDone"
  | "playbackStart"
  | "playbackEnd";

export type TurnLatencySummary = {
  assistantTurnId: number;
  userTurnId: number;
  providers: ProviderLabels;
  usedSpeculativeStart: boolean;
  metrics: Partial<{
    endOfTurnToFirstTextMs: number;
    endOfTurnToFirstAudioMs: number;
    endOfTurnToPlaybackStartMs: number;
  }>;
};

export type TurnTraceSummary = {
  assistantTurnId: number;
  userTurnId: number;
  providers: ProviderLabels;
  usedSpeculativeStart: boolean;
  metrics: Partial<{
    eagerEndOfTurnToEndOfTurnMs: number;
    endOfTurnToFirstTextMs: number;
    endOfTurnToLlmDoneMs: number;
    endOfTurnToTtsReadyMs: number;
    endOfTurnToFirstChunkSentToTtsMs: number;
    firstTextToFirstChunkSentToTtsMs: number;
    firstChunkSentToTtsToFirstAudioMs: number;
    endOfTurnToFirstAudioMs: number;
    endOfTurnToTtsDoneMs: number;
    firstAudioToPlaybackStartMs: number;
    endOfTurnToPlaybackStartMs: number;
    audioDurationMs: number;
    playbackStartToEstimatedPlaybackEndMs: number;
    endOfTurnToEstimatedPlaybackEndMs: number;
    playbackStartToPlaybackEndMs: number;
    endOfTurnToPlaybackEndMs: number;
  }>;
};

export type TurnLatencyMarkSnapshot = Partial<Record<TurnLatencyMilestone, number>>;

function diff(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) {
    return undefined;
  }

  return Math.max(0, end - start);
}

export class TurnLatencyTracker {
  private readonly marks = new Map<TurnLatencyMilestone, number>();

  constructor(
    private readonly assistantTurnId: number,
    private readonly userTurnId: number,
    private readonly providers: ProviderLabels,
  ) {}

  mark(milestone: TurnLatencyMilestone, at = Date.now()): void {
    if (!this.marks.has(milestone)) {
      this.marks.set(milestone, at);
    }
  }

  hasMark(milestone: TurnLatencyMilestone): boolean {
    return this.marks.has(milestone);
  }

  getMarks(): TurnLatencyMarkSnapshot {
    const snapshot: TurnLatencyMarkSnapshot = {};
    for (const [milestone, at] of this.marks.entries()) {
      snapshot[milestone] = at;
    }
    return snapshot;
  }

  getMarksRelativeTo(reference: TurnLatencyMilestone): TurnLatencyMarkSnapshot {
    const referenceAt = this.marks.get(reference);
    if (referenceAt === undefined) {
      return {};
    }

    const relative: TurnLatencyMarkSnapshot = {};
    for (const [milestone, at] of this.marks.entries()) {
      relative[milestone] = at - referenceAt;
    }
    return relative;
  }

  summarizeLatency(): TurnLatencySummary {
    const endOfTurn = this.marks.get("endOfTurn");
    const firstText = this.marks.get("firstText");
    const firstAudioGenerated = this.marks.get("firstAudioGenerated");
    const playbackStart = this.marks.get("playbackStart");

    return {
      assistantTurnId: this.assistantTurnId,
      userTurnId: this.userTurnId,
      providers: this.providers,
      usedSpeculativeStart: this.marks.has("eagerEndOfTurn"),
      metrics: {
        endOfTurnToFirstTextMs: diff(endOfTurn, firstText),
        endOfTurnToFirstAudioMs: diff(endOfTurn, firstAudioGenerated),
        endOfTurnToPlaybackStartMs: diff(endOfTurn, playbackStart),
      },
    };
  }

  summarizeTrace(audioDurationMs?: number): TurnTraceSummary {
    const eagerEndOfTurn = this.marks.get("eagerEndOfTurn");
    const endOfTurn = this.marks.get("endOfTurn");
    const firstText = this.marks.get("firstText");
    const llmDone = this.marks.get("llmDone");
    const ttsReady = this.marks.get("ttsReady");
    const firstChunkSentToTts = this.marks.get("firstChunkSentToTts");
    const firstAudioGenerated = this.marks.get("firstAudioGenerated");
    const ttsDone = this.marks.get("ttsDone");
    const playbackStart = this.marks.get("playbackStart");
    const playbackEnd = this.marks.get("playbackEnd");

    return {
      assistantTurnId: this.assistantTurnId,
      userTurnId: this.userTurnId,
      providers: this.providers,
      usedSpeculativeStart: this.marks.has("eagerEndOfTurn"),
      metrics: {
        eagerEndOfTurnToEndOfTurnMs: diff(eagerEndOfTurn, endOfTurn),
        endOfTurnToFirstTextMs: diff(endOfTurn, firstText),
        endOfTurnToLlmDoneMs: diff(endOfTurn, llmDone),
        endOfTurnToTtsReadyMs: diff(endOfTurn, ttsReady),
        endOfTurnToFirstChunkSentToTtsMs: diff(endOfTurn, firstChunkSentToTts),
        firstTextToFirstChunkSentToTtsMs: diff(firstText, firstChunkSentToTts),
        firstChunkSentToTtsToFirstAudioMs: diff(firstChunkSentToTts, firstAudioGenerated),
        endOfTurnToFirstAudioMs: diff(endOfTurn, firstAudioGenerated),
        endOfTurnToTtsDoneMs: diff(endOfTurn, ttsDone),
        firstAudioToPlaybackStartMs: diff(firstAudioGenerated, playbackStart),
        endOfTurnToPlaybackStartMs: diff(endOfTurn, playbackStart),
        audioDurationMs,
        playbackStartToEstimatedPlaybackEndMs: audioDurationMs,
        endOfTurnToEstimatedPlaybackEndMs:
          audioDurationMs !== undefined && diff(endOfTurn, playbackStart) !== undefined
            ? diff(endOfTurn, playbackStart)! + audioDurationMs
            : undefined,
        playbackStartToPlaybackEndMs: diff(playbackStart, playbackEnd),
        endOfTurnToPlaybackEndMs: diff(endOfTurn, playbackEnd),
      },
    };
  }
}

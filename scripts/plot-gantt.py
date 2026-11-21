#!/usr/bin/env -S uv run
# /// script
# dependencies = ["plotly", "kaleido"]
# ///
"""
Gantt chart of voice agent turn latency from wrangler tail logs.

Uses only marksTsMs from turn.trace events — no reconstruction from deltas.

Usage:
    pnpm tail -- --format json > /tmp/tail.json
    # (have a conversation, Ctrl-C)
    ./scripts/plot-gantt.py /tmp/tail.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import plotly.graph_objects as go
from plotly.subplots import make_subplots


@dataclass
class Turn:
    session_id: str
    assistant_turn_id: int
    user_turn_id: int | None
    providers: dict[str, str | None]
    speculative: bool
    marks: dict[str, float]  # milestone name -> absolute ms (epoch)
    audio_duration_ms: float | None


# Plotly categoryarray is bottom-to-top, so pipeline reads top-down.
LANES = ["Playback", "TTS", "LLM", "Turn Detection"]

COLORS = {
    "confirm_eot": "#64748B",
    "llm_ttft": "#818CF8",
    "llm_stream": "#4F46E5",
    "tts_buffer": "#FEF3C7",
    "tts_wait": "#FCD34D",
    "tts_stream": "#F59E0B",
    "play_delivery": "#86EFAC",
    "play_active": "#22C55E",
    "spec_fill": "rgba(99, 102, 241, 0.08)",
    "eot_line": "#475569",
    "ttft_line": "#4F46E5",
    "first_audio_line": "#D97706",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", type=Path, help="wrangler tail --format json output file")
    p.add_argument("--max-turns", type=int, default=3, help="max turns to render (takes most recent)")
    p.add_argument("--session", default=None, help="filter by session ID prefix")
    p.add_argument("--output", type=Path, default=Path("/tmp/voice-gantt"), help="output path (without extension)")
    p.add_argument("--title", default="Voice Agent Turn Latency")
    p.add_argument("--xmax", type=float, default=800, help="cap x-axis at this value (ms from EOT)")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_wrangler_tail(text: str) -> list[dict]:
    """Parse concatenated JSON objects from wrangler tail --format json."""
    objects: list[dict] = []
    depth = 0
    buf = ""
    in_str = False
    esc = False
    for ch in text:
        buf += ch
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    objects.append(json.loads(buf))
                except json.JSONDecodeError:
                    pass
                buf = ""
    return objects


def extract_turns(objects: list[dict], session_prefix: str | None, max_turns: int) -> list[Turn]:
    """Extract Turn objects from turn.trace log events, using marksTsMs as sole truth."""
    turns: list[Turn] = []
    for obj in objects:
        for log_entry in obj.get("logs", []):
            for msg in log_entry.get("message", []):
                if not isinstance(msg, str) or not msg.startswith("{"):
                    continue
                try:
                    event = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                if event.get("event") != "turn.trace":
                    continue
                marks_raw = event.get("marksTsMs")
                if not isinstance(marks_raw, dict) or "endOfTurn" not in marks_raw:
                    continue
                sid = event.get("sessionId", "")
                if session_prefix and not sid.startswith(session_prefix):
                    continue
                turns.append(Turn(
                    session_id=sid,
                    assistant_turn_id=event.get("assistantTurnId", 0),
                    user_turn_id=event.get("userTurnId"),
                    providers={
                        "turnDetector": event.get("turnDetector"),
                        "textGenerator": event.get("textGenerator"),
                        "speechSynthesizer": event.get("speechSynthesizer"),
                    },
                    speculative=bool(event.get("usedSpeculativeStart")),
                    marks={k: float(v) for k, v in marks_raw.items() if isinstance(v, (int, float))},
                    audio_duration_ms=event.get("audioDurationMs") if isinstance(event.get("audioDurationMs"), (int, float)) else None,
                ))
    turns.sort(key=lambda t: t.marks["endOfTurn"])
    return turns[-max_turns:]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def rel(marks: dict[str, float], key: str) -> float | None:
    """Milestone time in ms relative to endOfTurn."""
    eot = marks.get("endOfTurn")
    val = marks.get(key)
    if eot is None or val is None:
        return None
    return val - eot


def bar(fig: go.Figure, row: int, lane: str, start: float | None, end: float | None,
        color: str, name: str, show_legend: bool) -> None:
    if start is None or end is None:
        return
    dur = max(end - start, 1)
    fig.add_trace(
        go.Bar(
            x=[dur], y=[lane], base=[start], orientation="h",
            marker_color=color, width=0.5,
            name=name, showlegend=show_legend,
            hovertemplate=f"{name}<br>%{{base:.0f}} → %{{base+x:.0f}} ms  (%{{x:.0f}} ms)<extra></extra>",
        ),
        row=row, col=1,
    )


def render(turns: list[Turn], title: str, output: Path, xmax: float | None = None) -> None:
    if not turns:
        raise SystemExit("No complete turn.trace events with marksTsMs found.")

    n = len(turns)
    fig = make_subplots(rows=n, cols=1, shared_xaxes=True, vertical_spacing=max(0.06, 0.18 / n))

    legend_added: set[str] = set()
    global_min = 0.0
    global_max = 0.0

    def show(name: str) -> bool:
        first = name not in legend_added
        legend_added.add(name)
        return first

    for i, turn in enumerate(turns):
        row = i + 1
        m = turn.marks

        eager_eot = rel(m, "eagerEndOfTurn")
        llm_start = rel(m, "llmRequestStarted")
        first_text = rel(m, "firstText")
        llm_done = rel(m, "llmDone")
        first_chunk_to_tts = rel(m, "firstChunkSentToTts")
        tts_ready = rel(m, "ttsReady")
        first_audio = rel(m, "firstAudioGenerated")
        tts_done = rel(m, "ttsDone")
        audio_start_sent = rel(m, "audioStartSent")
        playback_start = rel(m, "playbackStart")
        playback_end = rel(m, "playbackEnd")

        # Estimate playback end from audio duration if not reported.
        if playback_end is None and playback_start is not None and turn.audio_duration_ms:
            playback_end = playback_start + turn.audio_duration_ms

        # -- Speculative window shading --
        if eager_eot is not None and eager_eot < 0:
            fig.add_vrect(
                x0=eager_eot, x1=0,
                fillcolor=COLORS["spec_fill"], line_width=0, layer="below",
                row=row, col=1,
            )

        # -- Lane: Turn Detection (eager EOT → confirmed EOT on speculative turns) --
        if eager_eot is not None and eager_eot < 0:
            bar(fig, row, "Turn Detection", eager_eot, 0.0, COLORS["confirm_eot"], "EOT confirm", show("EOT confirm"))

        # -- Lane: LLM (split into TTFT wait + streaming) --
        bar(fig, row, "LLM", llm_start or 0.0, first_text, COLORS["llm_ttft"], "LLM (TTFT)", show("LLM (TTFT)"))
        bar(fig, row, "LLM", first_text, llm_done, COLORS["llm_stream"], "LLM (stream)", show("LLM (stream)"))

        # -- Lane: TTS (buffering + processing + streaming) --
        bar(fig, row, "TTS", first_text, first_chunk_to_tts, COLORS["tts_buffer"], "TTS (buffering)", show("TTS (buffering)"))
        bar(fig, row, "TTS", first_chunk_to_tts, first_audio, COLORS["tts_wait"], "TTS (processing)", show("TTS (processing)"))
        bar(fig, row, "TTS", first_audio, tts_done, COLORS["tts_stream"], "TTS (streaming)", show("TTS (streaming)"))

        # -- Lane: Playback (split into delivery wait + active playback) --
        play_start = audio_start_sent or first_audio
        bar(fig, row, "Playback", play_start, playback_start, COLORS["play_delivery"], "Delivery", show("Delivery"))
        bar(fig, row, "Playback", playback_start, playback_end, COLORS["play_active"], "Playback", show("Playback"))

        # -- Critical chain markers: EOT and TTFT --
        ax = "" if row == 1 else str(row)

        if eager_eot is not None and eager_eot < 0:
            fig.add_vline(x=eager_eot, line_color=COLORS["confirm_eot"], line_dash="dot", line_width=1.2, row=row, col=1)
            fig.add_annotation(
                x=eager_eot, y=0.0, xref=f"x{ax}", yref=f"y{ax} domain",
                text=f"Eager EOT {eager_eot:.0f}ms", showarrow=False, xanchor="right", xshift=-4, yanchor="bottom",
                font=dict(size=9, color=COLORS["confirm_eot"]),
            )
        fig.add_vline(x=0, line_color=COLORS["eot_line"], line_dash="dot", line_width=1.5, row=row, col=1)
        fig.add_annotation(
            x=0, y=1.0, xref=f"x{ax}", yref=f"y{ax} domain",
            text="EOT 0ms", showarrow=False, xanchor="left", xshift=4, yanchor="top",
            font=dict(size=9, color=COLORS["eot_line"]),
        )
        if first_text is not None:
            fig.add_vline(x=first_text, line_color=COLORS["ttft_line"], line_dash="dash", line_width=1.5, row=row, col=1)
            fig.add_annotation(
                x=first_text, y=1.0, xref=f"x{ax}", yref=f"y{ax} domain",
                text=f"TTFT +{first_text:.0f}ms", showarrow=False, xanchor="left", xshift=4, yanchor="top",
                font=dict(size=9, color=COLORS["ttft_line"]),
            )
        if first_audio is not None:
            fig.add_vline(x=first_audio, line_color=COLORS["first_audio_line"], line_dash="dash", line_width=1.5, row=row, col=1)
            fig.add_annotation(
                x=first_audio, y=1.0, xref=f"x{ax}", yref=f"y{ax} domain",
                text=f"1st audio +{first_audio:.0f}ms", showarrow=False, xanchor="left", xshift=4, yanchor="top", yshift=-12,
                font=dict(size=9, color=COLORS["first_audio_line"]),
            )

        fig.add_annotation(
            x=0, y=1.0, xref=f"x{ax}", yref=f"y{ax} domain",
            text=f"<b>Turn {i + 1}</b>  <span style='color:#6B7280'>(a{turn.assistant_turn_id})</span>",
            showarrow=False, xanchor="left", yanchor="bottom", yshift=14,
            font=dict(size=13, color="#111827"),
        )

        stats: list[str] = []
        if first_text is not None:
            stats.append(f"TTFT {first_text:.0f}")
        if first_audio is not None:
            stats.append(f"1st audio {first_audio:.0f}")
        if playback_start is not None:
            stats.append(f"E2E {playback_start:.0f}")
        if eager_eot is not None:
            stats.append(f"spec {abs(eager_eot):.0f}")
        if stats:
            fig.add_annotation(
                x=1.0, y=1.0, xref=f"x{ax} domain", yref=f"y{ax} domain",
                text="  ".join(f"<b>{s}</b> ms" for s in stats),
                showarrow=False, xanchor="right", yanchor="top", yshift=10,
                font=dict(size=10, color="#6B7280"),
            )

        # Track x range.
        for v in (eager_eot, llm_start, tts_done, playback_end):
            if v is not None:
                global_min = min(global_min, v)
                global_max = max(global_max, v)

        fig.update_yaxes(categoryorder="array", categoryarray=LANES, row=row, col=1)

    if xmax is not None:
        global_max = min(global_max, xmax)
    pad = max(80, (global_max - global_min) * 0.06)
    fig.update_layout(
        title=dict(text=title, x=0.5, font=dict(size=20)),
        barmode="overlay",
        plot_bgcolor="white",
        paper_bgcolor="white",
        width=1500,
        height=max(350, 260 * n),
        margin=dict(l=120, r=80, t=80, b=100),
        legend=dict(orientation="h", x=0.5, xanchor="center", y=-0.08),
        font=dict(family="Inter, Arial, sans-serif", color="#374151"),
    )
    # Only show x-axis title on the last subplot.
    fig.update_xaxes(
        showgrid=True, gridcolor="#E5E7EB", griddash="dot", zeroline=False,
        range=[global_min - pad, global_max + pad],
    )
    fig.update_xaxes(title_text="ms relative to end-of-turn (0 = EOT)", row=n, col=1)
    fig.update_yaxes(showgrid=False, zeroline=False)

    for ext in ("html", "png", "svg"):
        path = output.with_suffix(f".{ext}")
        if ext == "html":
            fig.write_html(path)
        else:
            fig.write_image(path, scale=2 if ext == "png" else 1)
        print(path)


def main() -> None:
    args = parse_args()
    text = args.input.read_text()
    objects = parse_wrangler_tail(text)
    turns = extract_turns(objects, args.session, args.max_turns)
    render(turns, args.title, args.output, xmax=args.xmax)


if __name__ == "__main__":
    main()

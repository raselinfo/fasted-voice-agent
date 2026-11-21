# TTS Loudness Baseline

Probe URL: `http://127.0.0.1:8791`

Prompt set: `/home/aa0/Playground/voice-agent/scripts/provider-bench/tts-prompts.json`

Measured rounds: `1` after one warm-up per provider/model.

Target median speech RMS: `-21.40 dBFS`

| Provider | Model | Speech RMS Median (dBFS) | Loudness Median (LUFS) | Leading Silence Median (ms) | True Peak Median (dBFS) | Suggested Gain (dB) | TTFA Median (ms) |
|---|---|---:|---:|---:|---:|---:|---:|
| workers-ai | @cf/deepgram/aura-2-en | -22.90 | -24.60 | 300.0 | -8.80 | 1.50 | 118.5 |
| elevenlabs | eleven_flash_v2_5 | -21.40 | -23.80 | 60.0 | -6.85 | 0.00 | 1007.0 |
| together-orpheus | canopylabs/orpheus-3b-0.1-ft | -18.37 | -19.85 | 90.0 | -3.10 | -3.03 | 336.0 |

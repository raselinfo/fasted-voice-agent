import { concatChunks, encodeBase64, extractWavPcm16 } from './audio-analysis.mjs';

const ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';
const ELEVENLABS_OUTPUT_FORMAT = 'pcm_16000';
const GROQ_TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_ORPHEUS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_ORPHEUS_VOICE = 'troy';
const TOGETHER_TTS_URL = 'https://api.together.ai/v1/audio/speech';
const TOGETHER_ORPHEUS_MODEL = 'canopylabs/orpheus-3b-0.1-ft';
const TOGETHER_ORPHEUS_VOICE = 'leo';
const AURA_DEFAULT_SAMPLE_RATE = 16000;
const TURN_TIMEOUT_MS = 9000;
const TURN_CHUNK_MS = 80;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendFinalize(socket) {
  try {
    socket.send(JSON.stringify({ type: 'Finalize' }));
  } catch {
    // Some providers may ignore or reject control messages. The benchmark still
    // closes the socket after the timeout window if no final turn event arrives.
  }
}

function splitSseBuffer(buffer) {
  const parts = buffer.split('\n\n');
  return { completeBlocks: parts.slice(0, -1), remainder: parts.at(-1) ?? '' };
}

function extractSseData(block) {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));

  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).trimStart()).join('\n');
}

async function readFirstTextMetrics(stream, startedAt) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let firstTextAt = null;
  let totalBytes = 0;
  let preview = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    totalBytes += value.byteLength;
    pending += decoder.decode(value, { stream: true });
    const { completeBlocks, remainder } = splitSseBuffer(pending);
    pending = remainder;

    for (const block of completeBlocks) {
      const data = extractSseData(block);
      if (!data || data === '[DONE]') continue;
      if (firstTextAt === null) {
        firstTextAt = performance.now();
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        if (preview.length < 200) {
          preview += data;
        }
        continue;
      }
      const text = parsed.choices?.[0]?.delta?.content ?? parsed.response ?? parsed.output_text ?? '';
      if (text && preview.length < 200) {
        preview += text;
      } else if (!text && preview.length < 200) {
        preview += data;
      }
    }
  }

  pending += decoder.decode();
  return {
    ttftMs: firstTextAt === null ? null : Math.round(firstTextAt - startedAt),
    totalMs: Math.round(performance.now() - startedAt),
    totalBytes,
    preview: preview.slice(0, 200),
  };
}

async function readBinaryMetrics(stream, startedAt) {
  const reader = stream.getReader();
  let firstAudioAt = null;
  let totalBytes = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (firstAudioAt === null) firstAudioAt = performance.now();
    totalBytes += value.byteLength;
    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
  }

  return {
    ttfaMs: firstAudioAt === null ? null : Math.round(firstAudioAt - startedAt),
    ttsDoneMs: Math.round(performance.now() - startedAt),
    totalBytes,
    bytes: concatChunks(chunks, totalBytes),
  };
}

function parseWavDurationMs(bytes) {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const wave = String.fromCharCode(...bytes.slice(8, 12));
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = null;
  let bitsPerSample = null;
  let channels = null;
  let dataSize = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    }
    if (chunkId === 'data') {
      dataSize = chunkSize;
      break;
    }
    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !bitsPerSample || !channels || dataSize === null) {
    const fallbackBytes = Math.max(0, bytes.byteLength - 44);
    return Math.round((fallbackBytes / (AURA_DEFAULT_SAMPLE_RATE * 2)) * 1000);
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const durationMs = Math.round((dataSize / bytesPerSecond) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) {
    const fallbackBytes = Math.max(0, bytes.byteLength - 44);
    return Math.round((fallbackBytes / (AURA_DEFAULT_SAMPLE_RATE * 2)) * 1000);
  }
  return durationMs;
}

function pcmDurationMs(bytes, sampleRate) {
  return Math.round((bytes / (sampleRate * 2)) * 1000);
}

async function benchmarkWorkersAi(env, model, prompt, maxTokens) {
  const startedAt = performance.now();
  const stream = await env.AI.run(model, {
    prompt,
    stream: true,
    max_tokens: maxTokens,
  });
  return readFirstTextMetrics(stream, startedAt);
}

async function benchmarkGroq(env, model, prompt, maxTokens) {
  if (!env.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');
  const startedAt = performance.now();
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: 'Reply with exactly one token and no punctuation.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Groq request failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
  }
  return readFirstTextMetrics(response.body, startedAt);
}

async function benchmarkElevenLabs(env, text) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
  if (!env.ELEVENLABS_VOICE_ID) throw new Error('Missing ELEVENLABS_VOICE_ID');

  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}/stream`);
  url.searchParams.set('model_id', ELEVENLABS_MODEL_ID);
  url.searchParams.set('output_format', ELEVENLABS_OUTPUT_FORMAT);

  const startedAt = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'content-type': 'application/json',
      accept: 'audio/pcm',
    },
    body: JSON.stringify({ text }),
  });
  const connectMs = Math.round(performance.now() - startedAt);
  if (!response.ok || !response.body) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
  }
  const metrics = await readBinaryMetrics(response.body, startedAt);
  const audioDurationMs = pcmDurationMs(metrics.totalBytes, 16000);
  return {
    connectMs,
    ttfaMs: metrics.ttfaMs,
    ttsDoneMs: metrics.ttsDoneMs,
    audioBytes: metrics.totalBytes,
    audioDurationMs,
    realTimeFactor: audioDurationMs > 0 ? Number((metrics.ttsDoneMs / audioDurationMs).toFixed(3)) : null,
    outputFormat: ELEVENLABS_OUTPUT_FORMAT,
    sampleRate: 16000,
    pcmBytes: metrics.bytes,
  };
}

async function benchmarkAura(env, model, text, sampleRate = AURA_DEFAULT_SAMPLE_RATE) {
  const startedAt = performance.now();
  const response = await env.AI.run(model, {
    text,
    encoding: 'linear16',
    container: 'wav',
    sample_rate: sampleRate,
  }, {
    returnRawResponse: true,
  });
  const connectMs = Math.round(performance.now() - startedAt);
  if (!response?.body) {
    throw new Error(`Workers AI TTS response missing body for ${model}`);
  }
  const metrics = await readBinaryMetrics(response.body, startedAt);
  const normalizedAudio = extractWavPcm16(metrics.bytes);
  const audioDurationMs = pcmDurationMs(normalizedAudio.pcmBytes.byteLength, normalizedAudio.sampleRate);
  return {
    connectMs,
    ttfaMs: metrics.ttfaMs,
    ttsDoneMs: metrics.ttsDoneMs,
    audioBytes: metrics.totalBytes,
    audioDurationMs,
    realTimeFactor: audioDurationMs ? Number((metrics.ttsDoneMs / audioDurationMs).toFixed(3)) : null,
    outputFormat: 'wav/linear16',
    sampleRate: normalizedAudio.sampleRate,
    pcmBytes: normalizedAudio.pcmBytes,
  };
}

async function benchmarkGroqOrpheus(env, model, text, voice = GROQ_ORPHEUS_VOICE) {
  if (!env.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');

  const startedAt = performance.now();
  const response = await fetch(GROQ_TTS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: 'wav',
    }),
  });
  const connectMs = Math.round(performance.now() - startedAt);
  if (!response.ok || !response.body) {
    throw new Error(`Groq Orpheus request failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
  }

  const metrics = await readBinaryMetrics(response.body, startedAt);
  const normalizedAudio = extractWavPcm16(metrics.bytes);
  const audioDurationMs = pcmDurationMs(normalizedAudio.pcmBytes.byteLength, normalizedAudio.sampleRate);
  return {
    connectMs,
    ttfaMs: metrics.ttfaMs,
    ttsDoneMs: metrics.ttsDoneMs,
    audioBytes: metrics.totalBytes,
    audioDurationMs,
    realTimeFactor: audioDurationMs ? Number((metrics.ttsDoneMs / audioDurationMs).toFixed(3)) : null,
    outputFormat: 'wav',
    sampleRate: normalizedAudio.sampleRate,
    voice,
    pcmBytes: normalizedAudio.pcmBytes,
  };
}

function splitSseFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  return { frames: frames.slice(0, -1), remainder: frames.at(-1) ?? '' };
}

function parseSseData(frame) {
  const payloads = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      payloads.push(line.slice(5).trim());
    }
  }
  return payloads;
}

async function readTogetherPcmMetrics(stream, startedAt) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let firstAudioAt = null;
  let totalBytes = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    pending += decoder.decode(value, { stream: true });
    const { frames, remainder } = splitSseFrames(pending);
    pending = remainder;

    for (const frame of frames) {
      for (const data of parseSseData(frame)) {
        if (!data || data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (parsed.type === 'conversation.item.audio_output.delta' && typeof parsed.delta === 'string') {
          const chunk = decodeBase64(parsed.delta);
          if (chunk.byteLength === 0) continue;
          if (firstAudioAt === null) firstAudioAt = performance.now();
          totalBytes += chunk.byteLength;
          chunks.push(chunk);
        }

        if (parsed.type === 'conversation.item.tts.failed') {
          throw new Error(parsed.error?.message ?? 'Together Orpheus synthesis failed.');
        }
      }
    }
  }

  pending += decoder.decode();
  const { frames } = splitSseFrames(`${pending}\n\n`);
  for (const frame of frames) {
    for (const data of parseSseData(frame)) {
      if (!data || data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (parsed.type === 'conversation.item.audio_output.delta' && typeof parsed.delta === 'string') {
        const chunk = decodeBase64(parsed.delta);
        if (chunk.byteLength === 0) continue;
        if (firstAudioAt === null) firstAudioAt = performance.now();
        totalBytes += chunk.byteLength;
        chunks.push(chunk);
      }

      if (parsed.type === 'conversation.item.tts.failed') {
        throw new Error(parsed.error?.message ?? 'Together Orpheus synthesis failed.');
      }
    }
  }

  return {
    ttfaMs: firstAudioAt === null ? null : Math.round(firstAudioAt - startedAt),
    ttsDoneMs: Math.round(performance.now() - startedAt),
    totalBytes,
    bytes: concatChunks(chunks, totalBytes),
  };
}

async function benchmarkTogetherOrpheus(env, model, text, voice = TOGETHER_ORPHEUS_VOICE) {
  if (!env.TOGETHER_API_KEY) throw new Error('Missing TOGETHER_API_KEY');

  const startedAt = performance.now();
  const response = await fetch(TOGETHER_TTS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.TOGETHER_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: 'raw',
      response_encoding: 'pcm_s16le',
      sample_rate: 24000,
      stream: true,
    }),
  });
  const connectMs = Math.round(performance.now() - startedAt);
  if (!response.ok || !response.body) {
    throw new Error(`Together Orpheus request failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
  }

  const metrics = await readTogetherPcmMetrics(response.body, startedAt);
  const audioDurationMs = pcmDurationMs(metrics.totalBytes, 24000);
  return {
    connectMs,
    ttfaMs: metrics.ttfaMs,
    ttsDoneMs: metrics.ttsDoneMs,
    audioBytes: metrics.totalBytes,
    audioDurationMs,
    realTimeFactor: audioDurationMs > 0 ? Number((metrics.ttsDoneMs / audioDurationMs).toFixed(3)) : null,
    outputFormat: 'raw/pcm_s16le',
    sampleRate: 24000,
    voice,
    pcmBytes: metrics.bytes,
  };
}

function parseFluxEvent(rawData) {
  let payloadText = '';
  if (typeof rawData === 'string') payloadText = rawData;
  else if (rawData instanceof ArrayBuffer) payloadText = new TextDecoder().decode(rawData);
  else if (ArrayBuffer.isView(rawData)) payloadText = new TextDecoder().decode(rawData.buffer);
  else return null;

  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

async function openDeepgramSocket(env, options) {
  const apiKey = env.DEEPGRAM_API_KEY ?? env.DEEPGRAM_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');
  const url = new URL('https://api.deepgram.com/v2/listen');
  url.searchParams.set('model', options.model ?? 'flux-general-en');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(options.sampleRate));
  if (typeof options.eotThreshold === 'number') url.searchParams.set('eot_threshold', String(options.eotThreshold));
  if (typeof options.eagerEotThreshold === 'number') url.searchParams.set('eager_eot_threshold', String(options.eagerEotThreshold));
  if (typeof options.eotTimeoutMs === 'number') url.searchParams.set('eot_timeout_ms', String(options.eotTimeoutMs));

  const response = await fetch(url, { headers: { Authorization: `Token ${apiKey}`, Upgrade: 'websocket' } });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Deepgram Flux websocket upgrade failed with status ${response.status}`);
  socket.accept();
  return socket;
}

async function openWorkersAiFluxSocket(env, options) {
  const response = await env.AI.run('@cf/deepgram/flux', {
    encoding: 'linear16',
    sample_rate: String(options.sampleRate),
  }, {
    websocket: true,
  });
  const socket = response?.webSocket;
  if (!socket) throw new Error('Workers AI Flux websocket upgrade failed');
  socket.accept();
  return socket;
}

async function benchmarkFluxTurn(env, provider, payload) {
  const openedAt = performance.now();
  const socket = provider === 'workers-ai-flux'
    ? await openWorkersAiFluxSocket(env, payload)
    : await openDeepgramSocket(env, payload);
  const connectMs = Math.round(performance.now() - openedAt);

  let clipStartAt = null;
  let eagerAt = null;
  let endAt = null;
  let eagerTranscript = null;
  let finalTranscript = null;
  let falseResumeCount = 0;
  const rawEvents = [];

  let resolveFinished;
  let rejectFinished;
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  socket.addEventListener('message', (event) => {
    const parsed = parseFluxEvent(event.data);
    if (!parsed?.event) return;
    const now = performance.now();
    rawEvents.push({ event: parsed.event, atMs: clipStartAt === null ? null : Math.round(now - clipStartAt), transcript: parsed.transcript ?? null });
    if (parsed.event === 'EagerEndOfTurn') {
      eagerAt = now;
      eagerTranscript = parsed.transcript?.trim() || null;
    } else if (parsed.event === 'EndOfTurn') {
      endAt = now;
      finalTranscript = parsed.transcript?.trim() || null;
      resolveFinished();
    } else if (parsed.event === 'TurnResumed') {
      falseResumeCount += 1;
    }
  });
  socket.addEventListener('error', () => rejectFinished(new Error('Flux websocket error.')));
  socket.addEventListener('close', () => {
    if (endAt === null) resolveFinished();
  });

  const audio = decodeBase64(payload.audioBase64);
  const chunkBytes = Math.max(1, Math.round((payload.sampleRate * 2) * (TURN_CHUNK_MS / 1000)));
  clipStartAt = performance.now();
  for (let offset = 0; offset < audio.byteLength; offset += chunkBytes) {
    socket.send(audio.slice(offset, offset + chunkBytes));
    await sleep(TURN_CHUNK_MS);
  }
  sendFinalize(socket);

  await Promise.race([finished, sleep(TURN_TIMEOUT_MS)]);
  try { socket.close(1000, 'benchmark_done'); } catch {}

  const speechEndToEagerEndOfTurnMs = eagerAt === null ? null : Math.round(eagerAt - clipStartAt - payload.speechEndMs);
  const speechEndToEndOfTurnMs = endAt === null ? null : Math.round(endAt - clipStartAt - payload.speechEndMs);
  const eagerEndOfTurnToEndOfTurnMs = eagerAt === null || endAt === null ? null : Math.round(endAt - eagerAt);

  return {
    connectMs,
    speechEndToEagerEndOfTurnMs,
    speechEndToEndOfTurnMs,
    eagerEndOfTurnToEndOfTurnMs,
    falseResumeCount,
    eagerTranscript,
    finalTranscript,
    rawEvents,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      if (url.pathname === '/llm') {
        const { provider, model, prompt, maxTokens = 1 } = body ?? {};
        if (!provider || !model || !prompt) return json({ error: 'provider, model, prompt required' }, 400);
        const metrics = provider === 'workers-ai'
          ? await benchmarkWorkersAi(env, model, prompt, maxTokens)
          : await benchmarkGroq(env, model, prompt, maxTokens);
        return json({ provider, model, prompt, maxTokens, ...metrics });
      }

      if (url.pathname === '/tts') {
        const { provider, model, text, voice, captureAudio = false } = body ?? {};
        if (!provider || !text) return json({ error: 'provider and text required' }, 400);
        if (provider === 'workers-ai') {
          const resolvedModel = model ?? '@cf/deepgram/aura-1';
          const metrics = await benchmarkAura(env, resolvedModel, text);
          const { pcmBytes, ...responseMetrics } = metrics;
          return json({
            provider,
            model: resolvedModel,
            text,
            ...responseMetrics,
            ...(captureAudio ? { pcmBase64: encodeBase64(pcmBytes) } : {}),
          });
        }
        if (provider === 'elevenlabs') {
          const metrics = await benchmarkElevenLabs(env, text);
          const { pcmBytes, ...responseMetrics } = metrics;
          return json({
            provider,
            model: ELEVENLABS_MODEL_ID,
            text,
            ...responseMetrics,
            ...(captureAudio ? { pcmBase64: encodeBase64(pcmBytes) } : {}),
          });
        }
        if (provider === 'groq-orpheus') {
          const resolvedModel = model ?? GROQ_ORPHEUS_MODEL;
          const metrics = await benchmarkGroqOrpheus(env, resolvedModel, text, voice ?? GROQ_ORPHEUS_VOICE);
          const { pcmBytes, ...responseMetrics } = metrics;
          return json({
            provider,
            model: resolvedModel,
            text,
            ...responseMetrics,
            ...(captureAudio ? { pcmBase64: encodeBase64(pcmBytes) } : {}),
          });
        }
        if (provider === 'together-orpheus') {
          const resolvedModel = model ?? TOGETHER_ORPHEUS_MODEL;
          const metrics = await benchmarkTogetherOrpheus(env, resolvedModel, text, voice ?? TOGETHER_ORPHEUS_VOICE);
          const { pcmBytes, ...responseMetrics } = metrics;
          return json({
            provider,
            model: resolvedModel,
            text,
            ...responseMetrics,
            ...(captureAudio ? { pcmBase64: encodeBase64(pcmBytes) } : {}),
          });
        }
        return json({ error: 'Unsupported TTS provider' }, 400);
      }

      if (url.pathname === '/turn') {
        const { provider, audioBase64, sampleRate, speechEndMs } = body ?? {};
        if (!provider || !audioBase64 || typeof sampleRate !== 'number' || typeof speechEndMs !== 'number') {
          return json({ error: 'provider, audioBase64, sampleRate, speechEndMs required' }, 400);
        }
        if (provider !== 'deepgram-direct' && provider !== 'workers-ai-flux') {
          return json({ error: 'Unsupported turn provider' }, 400);
        }
        const metrics = await benchmarkFluxTurn(env, provider, body);
        return json({ provider, ...metrics });
      }

      return json({ error: 'Unknown route' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};

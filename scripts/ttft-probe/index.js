function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function readFirstChunkTimings(stream, startedAt) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let firstChunkAt = null;
  let totalBytes = 0;
  let preview = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value || value.byteLength === 0) {
      continue;
    }

    if (firstChunkAt === null) {
      firstChunkAt = performance.now();
    }

    totalBytes += value.byteLength;
    if (preview.length < 200) {
      preview += decoder.decode(value, { stream: true });
    }
  }

  preview += decoder.decode();

  return {
    ttftMs: firstChunkAt === null ? null : Math.round(firstChunkAt - startedAt),
    totalMs: Math.round(performance.now() - startedAt),
    totalBytes,
    preview: preview.slice(0, 200),
  };
}

async function benchmarkWorkersAi(env, model, prompt, maxTokens) {
  const startedAt = performance.now();
  const stream = await env.AI.run(model, {
    prompt,
    stream: true,
    max_tokens: maxTokens,
  });

  return readFirstChunkTimings(stream, startedAt);
}

async function benchmarkGroq(env, model, prompt, maxTokens) {
  if (!env.GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY");
  }

  const startedAt = performance.now();
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content: "Reply with exactly one token and no punctuation.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Groq request failed (${response.status}): ${body.slice(0, 400)}`);
  }

  return readFirstChunkTimings(response.body, startedAt);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "POST required" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const provider = body?.provider;
    const model = body?.model;
    const prompt = body?.prompt;
    const maxTokens = typeof body?.maxTokens === "number" ? body.maxTokens : 1;

    if (
      (provider !== "groq" && provider !== "workers-ai") ||
      typeof model !== "string" ||
      typeof prompt !== "string" ||
      !prompt.trim()
    ) {
      return json({ error: "provider, model, and prompt are required" }, 400);
    }

    try {
      const metrics =
        provider === "workers-ai"
          ? await benchmarkWorkersAi(env, model, prompt, maxTokens)
          : await benchmarkGroq(env, model, prompt, maxTokens);

      return json({
        provider,
        model,
        prompt,
        maxTokens,
        ...metrics,
      });
    } catch (error) {
      return json(
        {
          provider,
          model,
          prompt,
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
};

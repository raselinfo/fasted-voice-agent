import { SessionDO } from "../durable/session-do";
import { resolveTextGeneratorProvider, resolveTtsProvider, resolveTurnDetectorProvider } from "../providers/contracts";
import type { WorkersAiBinding } from "../providers/contracts";
import { buildPostHogBrowserBootstrapScript, buildPostHogBrowserConfig } from "../analytics/posthog";

export interface Env {
  SESSION_DO: DurableObjectNamespace<SessionDO>;
  ASSETS?: Fetcher;
  AI?: WorkersAiBinding;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_KEY?: string;
  GROQ_API_KEY?: string;
  GROQ_API_KEYS?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  TOGETHER_API_KEY?: string;
  TOGETHER_TTS_VOICE?: string;
  TURN_DETECTOR_PROVIDER?: string;
  TTS_PROVIDER?: string;
  TEXT_GENERATOR_PROVIDER?: string;
  APP_BASE_PATH?: string;
  POSTHOG_PROJECT_API_KEY?: string;
  POSTHOG_API_HOST?: string;
  POSTHOG_ENABLE_SESSION_REPLAY?: string;
  POSTHOG_CAPTURE_TRANSCRIPTS?: string;
}

function normalizeAppBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function prefixPath(basePath: string, suffix: string): string {
  return basePath ? `${basePath}${suffix}` : suffix;
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) {
    return pathname;
  }

  if (pathname === basePath || pathname === `${basePath}/`) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return null;
}

class PrefixAbsoluteAssetUrl {
  constructor(
    private readonly attributeName: "href" | "src",
    private readonly basePath: string,
  ) {}

  element(element: Element): void {
    const value = element.getAttribute(this.attributeName);
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
      return;
    }

    element.setAttribute(this.attributeName, `${this.basePath}${value}`);
  }
}

class InjectRuntimeConfigScript {
  constructor(
    private readonly basePath: string,
    private readonly postHogBootstrapScript: string | null,
  ) {}

  element(element: Element): void {
    const scripts = [`<script>window.__APP_BASE_PATH__=${JSON.stringify(this.basePath)};</script>`];
    if (this.postHogBootstrapScript) {
      scripts.push(this.postHogBootstrapScript);
    }

    element.append(scripts.join(""), {
      html: true,
    });
  }
}

function rewriteHtmlForBasePath(response: Response, basePath: string, env: Env): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  const postHogConfig = buildPostHogBrowserConfig(env);
  const postHogBootstrapScript = postHogConfig ? buildPostHogBrowserBootstrapScript(postHogConfig) : null;
  if (!basePath && !postHogBootstrapScript) {
    return response;
  }

  const rewriter = new HTMLRewriter().on("head", new InjectRuntimeConfigScript(basePath, postHogBootstrapScript));
  if (basePath) {
    rewriter.on('link[href^="/"]', new PrefixAbsoluteAssetUrl("href", basePath));
    rewriter.on('script[src^="/"]', new PrefixAbsoluteAssetUrl("src", basePath));
  }

  return rewriter.transform(response);
}

async function serveAsset(request: Request, env: Env, basePath: string): Promise<Response> {
  if (!env.ASSETS) {
    return new Response("Not Found", { status: 404 });
  }

  const assetUrl = new URL(request.url);
  const assetPath = stripBasePath(assetUrl.pathname, basePath);
  if (assetPath === null) {
    return new Response("Not Found", { status: 404 });
  }

  assetUrl.pathname = assetPath;
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  return rewriteHtmlForBasePath(assetResponse, basePath, env);
}

function resolveSessionId(requestUrl: URL): string {
  const requestedSessionId = requestUrl.searchParams.get("sessionId");
  return requestedSessionId && requestedSessionId.length > 0 ? requestedSessionId : crypto.randomUUID();
}

function hasDeepgramKey(env: Env): boolean {
  return [env.DEEPGRAM_API_KEY, env.DEEPGRAM_KEY].some((value) => typeof value === "string" && value.trim().length > 0);
}

function getMissingSecrets(env: Env) {
  const missingSecrets: string[] = [];
  const textGeneratorProvider = resolveTextGeneratorProvider(env.TEXT_GENERATOR_PROVIDER);
  const hasGroqKey =
    (typeof env.GROQ_API_KEYS === "string" && env.GROQ_API_KEYS.trim().length > 0) ||
    (typeof env.GROQ_API_KEY === "string" && env.GROQ_API_KEY.trim().length > 0);
  if (textGeneratorProvider === "groq" && !hasGroqKey) {
    missingSecrets.push("GROQ_API_KEYS");
  }

  const ttsProvider = resolveTtsProvider(env.TTS_PROVIDER);
  const ttsSecretKeys =
    ttsProvider === "elevenlabs"
      ? (["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"] as const)
      : ttsProvider === "together-orpheus"
        ? (["TOGETHER_API_KEY"] as const)
        : ([] as const);

  missingSecrets.push(
    ...ttsSecretKeys.filter((key) => {
      const value = env[key];
      return typeof value !== "string" || value.trim().length === 0;
    }),
  );

  if (resolveTurnDetectorProvider(env.TURN_DETECTOR_PROVIDER) === "deepgram-direct" && !hasDeepgramKey(env)) {
    missingSecrets.unshift("DEEPGRAM_KEY");
  }

  return missingSecrets;
}

function getMissingBindings(env: Env) {
  const missingBindings: string[] = [];

  const needsAiBinding =
    resolveTurnDetectorProvider(env.TURN_DETECTOR_PROVIDER) === "workers-ai-flux" ||
    resolveTtsProvider(env.TTS_PROVIDER) === "workers-ai-aura" ||
    resolveTextGeneratorProvider(env.TEXT_GENERATOR_PROVIDER) === "workers-ai";

  if (needsAiBinding) {
    if (!env.AI || typeof env.AI.run !== "function") {
      missingBindings.push("AI");
    }
  }

  return [...new Set(missingBindings)];
}

function buildHealthResponse(env: Env): Response {
  const missingSecrets = getMissingSecrets(env);
  const missingBindings = getMissingBindings(env);
  const ok = missingSecrets.length === 0 && missingBindings.length === 0;

  return Response.json(
    {
      ok,
      service: "voice-agent",
      missingSecrets,
      missingBindings,
      runtime: "cloudflare-workers",
    },
    {
      status: ok ? 200 : 503,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const basePath = normalizeAppBasePath(env.APP_BASE_PATH);
    const healthPath = prefixPath(basePath, "/api/health");
    const sessionPath = prefixPath(basePath, "/api/session");

    if (url.pathname === healthPath && request.method === "GET") {
      return buildHealthResponse(env);
    }

    if (url.pathname !== sessionPath) {
      return serveAsset(request, env, basePath);
    }

    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const sessionId = resolveSessionId(url);
    const forwardUrl = new URL(url.toString());
    forwardUrl.pathname = "/api/session";
    forwardUrl.searchParams.set("sessionId", sessionId);

    const sessionStub = env.SESSION_DO.getByName(sessionId);
    const forwardRequest = new Request(forwardUrl.toString(), request);
    return sessionStub.fetch(forwardRequest);
  },
} satisfies ExportedHandler<Env>;

export { SessionDO };

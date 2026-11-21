import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

const plainNodeTestFiles = new Set([
  path.normalize("tests/quick/groq.spec.ts"),
  path.normalize("tests/quick/pcm-gain.spec.ts"),
  path.normalize("tests/quick/workers-ai-aura.spec.ts"),
  path.normalize("tests/quick/vad-assets.spec.ts"),
  path.normalize("tests/quick/provider-bench-audio-analysis.spec.ts"),
  path.normalize("tests/quick/provider-bench-tts-benchmark.spec.ts"),
  path.normalize("tests/session-foundation/ui-start.spec.ts"),
  path.normalize("tests/session-foundation/ui-base-path.spec.ts"),
  path.normalize("tests/realtime-voice-loop/interruption-ui.spec.ts"),
]);

const requestedSpecFiles = process.argv
  .slice(2)
  .filter((value) => value.endsWith(".spec.ts"))
  .map((value) => path.normalize(value));

const useWorkersPool =
  requestedSpecFiles.length === 0 || requestedSpecFiles.some((filePath) => !plainNodeTestFiles.has(filePath));

export default defineConfig({
  plugins: useWorkersPool
    ? [
        cloudflareTest({
          main: "./src/worker/index.ts",
          wrangler: {
            configPath: "./wrangler.jsonc",
          },
        }),
      ]
    : [],
  test: {
    include: ["tests/**/*.spec.ts"],
  },
});

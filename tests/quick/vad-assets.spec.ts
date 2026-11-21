import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error local JS helper exports are covered by runtime tests here
import { resolveVadAssetManifest, syncVadAssets } from "../../scripts/sync-vad-assets.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dirPath) =>
      rm(dirPath, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("VAD asset sync", () => {
  it("resolves the expected VAD and ORT browser asset manifest", async () => {
    const manifest: Array<{ targetRelativePath: string }> = await resolveVadAssetManifest();
    const targetPaths = manifest.map((entry: { targetRelativePath: string }) => entry.targetRelativePath);

    expect(targetPaths).toContain(path.join("vendor", "vad", "bundle.min.js"));
    expect(targetPaths).toContain(path.join("vendor", "vad", "vad.worklet.bundle.min.js"));
    expect(targetPaths).toContain(path.join("vendor", "vad", "silero_vad_v5.onnx"));
    expect(targetPaths).toContain(path.join("vendor", "ort", "ort.wasm.min.js"));
    expect(
      targetPaths.some((targetPath) => targetPath.startsWith(path.join("vendor", "ort")) && targetPath.endsWith(".mjs")),
    ).toBe(true);
    expect(
      targetPaths.some((targetPath) => targetPath.startsWith(path.join("vendor", "ort")) && targetPath.endsWith(".wasm")),
    ).toBe(true);
  });

  it("syncs assets into a target tree and check mode catches drift", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vad-assets-"));
    tempDirs.push(tempRoot);

    const manifest: Array<{ targetRelativePath: string }> = await syncVadAssets({ targetRoot: tempRoot });
    expect(manifest.length).toBeGreaterThan(4);

    await expect(syncVadAssets({ targetRoot: tempRoot, checkOnly: true })).resolves.toHaveLength(manifest.length);

    const bundlePath = path.join(tempRoot, "vendor", "vad", "bundle.min.js");
    const originalBundle = await readFile(bundlePath, "utf8");
    await writeFile(bundlePath, `${originalBundle}\n// drift`);

    await expect(syncVadAssets({ targetRoot: tempRoot, checkOnly: true })).rejects.toThrow("Out-of-sync asset");
  });
});

describe("Static VAD bundle wiring", () => {
  it("loads self-hosted ORT and VAD bundles before the app module", async () => {
    const html = await readFile(path.join(process.cwd(), "src", "web", "index.html"), "utf8");
    const ortScriptIndex = html.indexOf('<script src="/vendor/ort/ort.wasm.min.js"></script>');
    const vadScriptIndex = html.indexOf('<script src="/vendor/vad/bundle.min.js"></script>');
    const appScriptIndex = html.indexOf('<script type="module" src="/app.js"></script>');

    expect(ortScriptIndex).toBeGreaterThan(-1);
    expect(vadScriptIndex).toBeGreaterThan(ortScriptIndex);
    expect(appScriptIndex).toBeGreaterThan(vadScriptIndex);
  });

  it("includes the benchmarked ElevenLabs voice alongside Adam in the UI voice list", async () => {
    const html = await readFile(path.join(process.cwd(), "src", "web", "index.html"), "utf8");

    expect(html).toContain('<option data-provider-key="elevenlabs-flash" value="CwhRBWXzGAHq8TQ4Fs17">Roger</option>');
    expect(html).toContain('<option data-provider-key="elevenlabs-flash" value="pNInz6obpgDQGcFmaJgB">Adam</option>');
    expect(
      html.indexOf('<option data-provider-key="elevenlabs-flash" value="CwhRBWXzGAHq8TQ4Fs17">Roger</option>'),
    ).toBeLessThan(
      html.indexOf('<option data-provider-key="elevenlabs-flash" value="pNInz6obpgDQGcFmaJgB">Adam</option>'),
    );
  });
});

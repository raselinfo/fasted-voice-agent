import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const projectRoot = path.resolve(scriptDir, "..");
const defaultWebRoot = path.join(projectRoot, "src", "web");

const VAD_STATIC_FILES = [
  "bundle.min.js",
  "bundle.min.js.LICENSE.txt",
  "vad.worklet.bundle.min.js",
  "silero_vad_v5.onnx",
];
const ORT_RUNTIME_FILES = [
  "ort.wasm.min.js",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

function resolveVadPackageDir() {
  return path.dirname(require.resolve("@ricky0123/vad-web/package.json"));
}

async function resolveOrtPackageDir(vadPackageDir = resolveVadPackageDir()) {
  return realpath(path.join(vadPackageDir, "..", "..", "onnxruntime-web"));
}

async function listOrtRuntimeFiles(ortDistDir) {
  const entries = new Set(
    (await readdir(ortDistDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  for (const fileName of ORT_RUNTIME_FILES) {
    if (!entries.has(fileName)) {
      throw new Error(`Missing ORT runtime asset in dist/: ${fileName}`);
    }
  }

  return [...ORT_RUNTIME_FILES];
}

export async function resolveVadAssetManifest() {
  const vadPackageDir = resolveVadPackageDir();
  const vadDistDir = path.join(vadPackageDir, "dist");
  const ortPackageDir = await resolveOrtPackageDir(vadPackageDir);
  const ortDistDir = path.join(ortPackageDir, "dist");
  const ortFiles = await listOrtRuntimeFiles(ortDistDir);

  return [
    ...VAD_STATIC_FILES.map((name) => ({
      sourcePath: path.join(vadDistDir, name),
      targetRelativePath: path.join("vendor", "vad", name),
    })),
    ...ortFiles.map((name) => ({
      sourcePath: path.join(ortDistDir, name),
      targetRelativePath: path.join("vendor", "ort", name),
    })),
  ].sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function filesMatch(sourcePath, targetPath) {
  const [sourceBuffer, targetBuffer] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
  return sourceBuffer.equals(targetBuffer);
}

async function listFilesRecursively(dirPath) {
  const results = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

async function removeExtraManagedFiles(targetRoot, expectedRelativePaths) {
  const managedDirs = [path.join(targetRoot, "vendor", "vad"), path.join(targetRoot, "vendor", "ort")];
  const expectedAbsolutePaths = new Set(expectedRelativePaths.map((relativePath) => path.join(targetRoot, relativePath)));

  for (const managedDir of managedDirs) {
    if (!(await fileExists(managedDir))) {
      continue;
    }

    const existingFiles = await listFilesRecursively(managedDir);
    for (const existingFile of existingFiles) {
      if (!expectedAbsolutePaths.has(existingFile)) {
        await rm(existingFile);
      }
    }
  }
}

async function collectExtraManagedFiles(targetRoot, expectedRelativePaths) {
  const managedDirs = [path.join(targetRoot, "vendor", "vad"), path.join(targetRoot, "vendor", "ort")];
  const expectedAbsolutePaths = new Set(expectedRelativePaths.map((relativePath) => path.join(targetRoot, relativePath)));
  const extras = [];

  for (const managedDir of managedDirs) {
    if (!(await fileExists(managedDir))) {
      continue;
    }

    const existingFiles = await listFilesRecursively(managedDir);
    for (const existingFile of existingFiles) {
      if (!expectedAbsolutePaths.has(existingFile)) {
        extras.push(path.relative(targetRoot, existingFile));
      }
    }
  }

  return extras.sort();
}

export async function syncVadAssets({ targetRoot = defaultWebRoot, checkOnly = false } = {}) {
  const manifest = await resolveVadAssetManifest();
  const issues = [];

  for (const { sourcePath, targetRelativePath } of manifest) {
    const targetPath = path.join(targetRoot, targetRelativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (!(await fileExists(sourcePath))) {
      issues.push(`Missing source asset: ${sourcePath}`);
      continue;
    }

    const targetExists = await fileExists(targetPath);
    if (checkOnly) {
      if (!targetExists) {
        issues.push(`Missing target asset: ${targetRelativePath}`);
        continue;
      }

      if (!(await filesMatch(sourcePath, targetPath))) {
        issues.push(`Out-of-sync asset: ${targetRelativePath}`);
      }
      continue;
    }

    if (!targetExists || !(await filesMatch(sourcePath, targetPath))) {
      const bytes = await readFile(sourcePath);
      await writeFile(targetPath, bytes);
    }
  }

  const expectedRelativePaths = manifest.map(({ targetRelativePath }) => targetRelativePath);
  if (checkOnly) {
    const extras = await collectExtraManagedFiles(targetRoot, expectedRelativePaths);
    issues.push(...extras.map((relativePath) => `Unexpected managed asset: ${relativePath}`));
  } else {
    await removeExtraManagedFiles(targetRoot, expectedRelativePaths);
  }

  if (issues.length > 0) {
    throw new Error(`VAD asset sync check failed:\n- ${issues.join("\n- ")}`);
  }

  return manifest;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const manifest = await syncVadAssets({ checkOnly });
  console.log(
    `${checkOnly ? "Verified" : "Synced"} ${manifest.length} VAD/browser runtime assets into ${path.relative(projectRoot, defaultWebRoot)}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

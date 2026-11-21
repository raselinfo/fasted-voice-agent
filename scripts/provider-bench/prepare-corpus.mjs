import { mkdir, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const MANIFEST_PATH = resolve(ROOT, 'scripts/provider-bench/corpus-manifest.jsonl');
const DEFAULT_CACHE_DIR = resolve(ROOT, '.cache/provider-bench');

function parseArgs(argv) {
  const options = {
    dryRun: false,
    limit: Infinity,
    cacheDir: DEFAULT_CACHE_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') options.dryRun = true;
    else if (token === '--limit') options.limit = Number(argv[index + 1] ?? 'Infinity');
    else if (token.startsWith('--limit=')) options.limit = Number(token.split('=')[1]);
    else if (token === '--cache-dir') options.cacheDir = resolve(ROOT, argv[index + 1] ?? DEFAULT_CACHE_DIR);
    else if (token.startsWith('--cache-dir=')) options.cacheDir = resolve(ROOT, token.split('=')[1]);
  }

  return options;
}

function readJsonLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function fileExists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function ensureSourceAudio(entry, sourcePath, dryRun) {
  if (await fileExists(sourcePath)) {
    return { downloaded: false, sourcePath };
  }

  if (dryRun) {
    return { downloaded: false, sourcePath, plannedDownload: entry.sourceAudioUrl };
  }

  await ensureDir(dirname(sourcePath));
  await execFile('curl', ['-L', '--fail', '--silent', '--show-error', '-o', sourcePath, entry.sourceAudioUrl]);
  return { downloaded: true, sourcePath };
}

async function ensureClip(entry, sourcePath, clipPath, dryRun) {
  if (await fileExists(clipPath)) {
    return { created: false, clipPath };
  }

  if (dryRun) {
    return { created: false, clipPath, plannedClip: { startMs: entry.clipStartMs, endMs: entry.clipEndMs } };
  }

  await ensureDir(dirname(clipPath));
  const durationSeconds = Math.max(0.1, (entry.clipEndMs - entry.clipStartMs) / 1000);
  await execFile('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-ss', String(entry.clipStartMs / 1000),
    '-t', String(durationSeconds),
    '-i', sourcePath,
    '-ac', '1',
    '-ar', String(entry.sampleRate),
    '-c:a', 'pcm_s16le',
    clipPath,
  ]);
  return { created: true, clipPath };
}

const options = parseArgs(process.argv.slice(2));
const manifest = readJsonLines(await readFile(MANIFEST_PATH, 'utf8')).slice(0, options.limit);
const summaries = [];

for (const entry of manifest) {
  const sourcePath = resolve(ROOT, options.cacheDir, 'sources', entry.sourceAudioUrl.split('/').at(-1));
  const clipPath = resolve(ROOT, entry.audioPath);
  const source = await ensureSourceAudio(entry, sourcePath, options.dryRun);
  const clip = await ensureClip(entry, sourcePath, clipPath, options.dryRun);
  summaries.push({
    id: entry.id,
    sourcePath,
    clipPath,
    sampleRate: entry.sampleRate,
    speechEndMs: entry.speechEndMs,
    downloaded: Boolean(source.downloaded),
    created: Boolean(clip.created),
    plannedDownload: source.plannedDownload ?? null,
    plannedClip: clip.plannedClip ?? null,
    text: entry.text,
    tags: entry.tags,
  });
}

console.log(JSON.stringify({
  dryRun: options.dryRun,
  limit: Number.isFinite(options.limit) ? options.limit : manifest.length,
  cacheDir: options.cacheDir,
  manifestPath: MANIFEST_PATH,
  clips: summaries,
}, null, 2));

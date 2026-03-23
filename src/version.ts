import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getHudPluginDir } from './claude-config-dir.js';

type ExecFileResult = {
  stdout: string;
};

type ExecFileImpl = (
  file: string,
  args: string[],
  options: {
    timeout: number;
    encoding: BufferEncoding;
  }
) => Promise<ExecFileResult>;

type ClaudeBinaryInfo = {
  path: string;
  mtimeMs: number;
};

type VersionCacheFile = {
  binaryPath: string;
  binaryMtimeMs: number;
  version: string | null;
};

const CACHE_FILENAME = '.claude-code-version-cache.json';
const defaultExecFile: ExecFileImpl = promisify(execFile) as ExecFileImpl;

let execFileImpl: ExecFileImpl = defaultExecFile;
let resolveClaudeBinaryImpl: () => ClaudeBinaryInfo | null = resolveClaudeBinaryFromPath;
let cachedBinaryKey: string | undefined;
let cachedVersion: string | undefined;
let hasResolved = false;

function getVersionCachePath(homeDir: string): string {
  return path.join(getHudPluginDir(homeDir), CACHE_FILENAME);
}

function getBinaryCacheKey(binaryInfo: ClaudeBinaryInfo): string {
  return `${binaryInfo.path}:${binaryInfo.mtimeMs}`;
}

function readVersionCache(homeDir: string): VersionCacheFile | null {
  try {
    const cachePath = getVersionCachePath(homeDir);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as VersionCacheFile;
    if (
      typeof parsed.binaryPath !== 'string'
      || typeof parsed.binaryMtimeMs !== 'number'
      || (typeof parsed.version !== 'string' && parsed.version !== null)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeVersionCache(homeDir: string, cache: VersionCacheFile): void {
  try {
    const cachePath = getVersionCachePath(homeDir);
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    // Ignore cache write failures.
  }
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile()) {
      return false;
    }

    if (process.platform === 'win32') {
      return true;
    }

    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathCandidates(command: string): string[] {
  if (process.platform !== 'win32') {
    return [command];
  }

  const ext = path.extname(command);
  if (ext) {
    return [command];
  }

  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);

  return [command, ...pathExt.map((suffix) => `${command}${suffix.toLowerCase()}`), ...pathExt.map((suffix) => `${command}${suffix.toUpperCase()}`)];
}

function resolveClaudeBinaryFromPath(): ClaudeBinaryInfo | null {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  const candidates = getPathCandidates('claude');
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) {
      continue;
    }

    const dir = entry.replace(/^"(.*)"$/, '$1');
    for (const candidate of candidates) {
      const candidatePath = path.join(dir, candidate);
      if (!isExecutableFile(candidatePath)) {
        continue;
      }

      try {
        const realPath = fs.realpathSync(candidatePath);
        const stat = fs.statSync(realPath);
        return {
          path: realPath,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function _parseClaudeCodeVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  return match?.[0];
}

export async function getClaudeCodeVersion(): Promise<string | undefined> {
  const binaryInfo = resolveClaudeBinaryImpl();
  if (!binaryInfo) {
    return undefined;
  }

  const binaryKey = getBinaryCacheKey(binaryInfo);
  if (hasResolved && cachedBinaryKey === binaryKey) {
    return cachedVersion;
  }

  const homeDir = os.homedir();
  const diskCache = readVersionCache(homeDir);
  if (
    diskCache
    && diskCache.binaryPath === binaryInfo.path
    && diskCache.binaryMtimeMs === binaryInfo.mtimeMs
  ) {
    cachedBinaryKey = binaryKey;
    cachedVersion = diskCache.version ?? undefined;
    hasResolved = true;
    return cachedVersion;
  }

  try {
    const { stdout } = await execFileImpl('claude', ['--version'], {
      timeout: 2000,
      encoding: 'utf8',
    });
    cachedVersion = _parseClaudeCodeVersion(stdout);
  } catch {
    cachedVersion = undefined;
  }

  writeVersionCache(homeDir, {
    binaryPath: binaryInfo.path,
    binaryMtimeMs: binaryInfo.mtimeMs,
    version: cachedVersion ?? null,
  });

  cachedBinaryKey = binaryKey;
  hasResolved = true;
  return cachedVersion;
}

export function _resetVersionCache(): void {
  cachedBinaryKey = undefined;
  cachedVersion = undefined;
  hasResolved = false;
}

export function _setExecFileImplForTests(impl: ExecFileImpl | null): void {
  execFileImpl = impl ?? defaultExecFile;
}

export function _setResolveClaudeBinaryForTests(impl: (() => ClaudeBinaryInfo | null) | null): void {
  resolveClaudeBinaryImpl = impl ?? resolveClaudeBinaryFromPath;
}

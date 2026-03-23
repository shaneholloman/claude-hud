import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _parseClaudeCodeVersion,
  _resetVersionCache,
  _setExecFileImplForTests,
  _setResolveClaudeBinaryForTests,
  getClaudeCodeVersion,
} from '../dist/version.js';

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  _resetVersionCache();
  _setExecFileImplForTests(null);
  _setResolveClaudeBinaryForTests(null);
});

test('_parseClaudeCodeVersion preserves prerelease and build suffixes', () => {
  assert.equal(_parseClaudeCodeVersion('2.1.81 (Claude Code)\n'), '2.1.81');
  assert.equal(_parseClaudeCodeVersion('2.2.0-beta.1 (Claude Code)\n'), '2.2.0-beta.1');
  assert.equal(_parseClaudeCodeVersion('Claude Code 2.2.0-beta.1+abc123'), '2.2.0-beta.1+abc123');
  assert.equal(_parseClaudeCodeVersion(''), undefined);
});

test('getClaudeCodeVersion persists cache across process resets under CLAUDE_CONFIG_DIR', async () => {
  const tempHome = await mkdtemp(path.join(tmpdir(), 'claude-hud-version-'));
  const customConfigDir = path.join(tempHome, '.claude-alt');
  const binaryPath = path.join(tempHome, 'claude');
  const originalHome = process.env.HOME;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let execCalls = 0;

  process.env.HOME = tempHome;
  process.env.CLAUDE_CONFIG_DIR = customConfigDir;
  await writeFile(binaryPath, '#!/bin/sh\n', 'utf8');
  const binaryMtimeMs = 1710000000000;
  utimesSync(binaryPath, binaryMtimeMs / 1000, binaryMtimeMs / 1000);

  try {
    _setResolveClaudeBinaryForTests(() => ({ path: binaryPath, mtimeMs: binaryMtimeMs }));
    _setExecFileImplForTests(async () => {
      execCalls += 1;
      return { stdout: '2.2.0-beta.1+abc123 (Claude Code)\n' };
    });

    const first = await getClaudeCodeVersion();
    assert.equal(first, '2.2.0-beta.1+abc123');
    assert.equal(execCalls, 1);

    const cachePath = path.join(customConfigDir, 'plugins', 'claude-hud', '.claude-code-version-cache.json');
    assert.equal(existsSync(cachePath), true);

    _resetVersionCache();
    _setExecFileImplForTests(async () => {
      throw new Error('should not shell out when disk cache is valid');
    });

    const second = await getClaudeCodeVersion();
    assert.equal(second, '2.2.0-beta.1+abc123');
    assert.equal(execCalls, 1);
  } finally {
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('getClaudeCodeVersion refreshes when the Claude binary mtime changes', async () => {
  const tempHome = await mkdtemp(path.join(tmpdir(), 'claude-hud-version-invalidate-'));
  const customConfigDir = path.join(tempHome, '.claude-alt');
  const binaryPath = path.join(tempHome, 'claude');
  const originalHome = process.env.HOME;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let execCalls = 0;
  let currentMtimeMs = 1710000000000;

  process.env.HOME = tempHome;
  process.env.CLAUDE_CONFIG_DIR = customConfigDir;
  await writeFile(binaryPath, '#!/bin/sh\n', 'utf8');
  utimesSync(binaryPath, currentMtimeMs / 1000, currentMtimeMs / 1000);

  try {
    _setResolveClaudeBinaryForTests(() => ({ path: binaryPath, mtimeMs: currentMtimeMs }));
    _setExecFileImplForTests(async () => {
      execCalls += 1;
      return { stdout: execCalls === 1 ? '2.1.81 (Claude Code)\n' : '2.2.0-beta.1 (Claude Code)\n' };
    });

    const first = await getClaudeCodeVersion();
    assert.equal(first, '2.1.81');
    assert.equal(execCalls, 1);

    _resetVersionCache();
    currentMtimeMs += 1000;
    utimesSync(binaryPath, currentMtimeMs / 1000, currentMtimeMs / 1000);

    const second = await getClaudeCodeVersion();
    assert.equal(second, '2.2.0-beta.1');
    assert.equal(execCalls, 2);
  } finally {
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(tempHome, { recursive: true, force: true });
  }
});

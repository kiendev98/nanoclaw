/**
 * The repository catalog is the only thing standing between "delegate into
 * nanoclaw" and "delegate into any directory on this host", so its refusals are
 * tested as carefully as its successes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeRefusal, isRepoRefusal, listRepoNames, resolveRepo } from './repo-registry.js';

const ROOTS_ENV_VAR = 'NANOCLAW_PROJECT_ROOTS';

let tempRoot: string;
let previousRoots: string | undefined;

function makeRepo(name: string): string {
  const repo = path.join(tempRoot, 'projects', name);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-repo-registry-'));
  fs.mkdirSync(path.join(tempRoot, 'projects'), { recursive: true });
  previousRoots = process.env[ROOTS_ENV_VAR];
  process.env[ROOTS_ENV_VAR] = path.join(tempRoot, 'projects');
});

afterEach(() => {
  if (previousRoots === undefined) delete process.env[ROOTS_ENV_VAR];
  else process.env[ROOTS_ENV_VAR] = previousRoots;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('resolveRepo', () => {
  it('resolves a git checkout directly inside a configured folder', () => {
    const repo = makeRepo('nanoclaw');
    const result = resolveRepo('nanoclaw');
    expect(isRepoRefusal(result)).toBe(false);
    expect((result as { hostPath: string }).hostPath).toBe(fs.realpathSync(repo));
  });

  // macOS and Windows match a path case-insensitively, and realpath returns the
  // spelling the caller asked for. Unchecked, "Nanoclaw" and "nanoclaw" become
  // two workers over one checkout, each with its own worktree and memory.
  it('refuses a name whose case does not match the directory on disk', () => {
    makeRepo('nanoclaw');
    const result = resolveRepo('Nanoclaw');
    expect(isRepoRefusal(result)).toBe(true);
    expect((result as { kind: string }).kind).toBe('unknown-name');
  });

  it('ignores a directory that is not a git checkout', () => {
    fs.mkdirSync(path.join(tempRoot, 'projects', 'notes'), { recursive: true });
    makeRepo('nanoclaw');
    expect(listRepoNames()).toEqual(['nanoclaw']);
  });

  it('refuses a name carrying a path separator without normalising it', () => {
    makeRepo('nanoclaw');
    const result = resolveRepo('../../etc');
    expect(isRepoRefusal(result)).toBe(true);
    expect((result as { kind: string }).kind).toBe('malformed-name');
  });

  it('refuses a symlink that escapes the configured folder', () => {
    makeRepo('nanoclaw');
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
    fs.symlinkSync(outside, path.join(tempRoot, 'projects', 'escape'));

    const result = resolveRepo('escape');
    expect(isRepoRefusal(result)).toBe(true);
    expect((result as { kind: string }).kind).toBe('unknown-name');
  });

  it('names the repositories a caller may retry with, and no paths (E1, E3)', () => {
    makeRepo('nanoclaw');
    makeRepo('saber');
    const result = resolveRepo('nanoclow');
    expect(isRepoRefusal(result)).toBe(true);

    const refusal = result as Parameters<typeof describeRefusal>[0];
    expect(refusal.retryable).toBe(true);
    const text = describeRefusal(refusal);
    expect(text).toContain('nanoclaw');
    expect(text).toContain('saber');
    expect(text).not.toContain(tempRoot);
  });

  it('offers no retry and no list when nothing is configured (E2)', () => {
    delete process.env[ROOTS_ENV_VAR];
    const result = resolveRepo('nanoclaw');
    expect(isRepoRefusal(result)).toBe(true);

    const refusal = result as Parameters<typeof describeRefusal>[0];
    expect(refusal.retryable).toBe(false);
    expect(describeRefusal(refusal)).toContain('Retrying will not help');
  });

  it('offers no retry and no list when the configured folder holds no repository (E2)', () => {
    const result = resolveRepo('nanoclaw');
    expect((result as { kind: string }).kind).toBe('no-repositories');
    expect(describeRefusal(result as Parameters<typeof describeRefusal>[0])).not.toContain('Available');
  });

  it('reads every configured folder', () => {
    const second = path.join(tempRoot, 'more');
    fs.mkdirSync(path.join(second, 'saber', '.git'), { recursive: true });
    process.env[ROOTS_ENV_VAR] = [path.join(tempRoot, 'projects'), second].join(path.delimiter);
    makeRepo('nanoclaw');

    expect(listRepoNames()).toEqual(['nanoclaw', 'saber']);
  });
});

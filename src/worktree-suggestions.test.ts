/**
 * A refusal that names the roots but not the repositories is a dead end.
 *
 * `spawn_worker` takes a repository NAME from a chat message, and a mistyped
 * one fails resolution. The old refusal said which directories were allowed,
 * which is what an OPERATOR needs — but the caller is an agent that cannot
 * list them, so its only move was to guess again. Two turns to learn one fact,
 * and often an apology to the human instead of a retry.
 *
 * These tests fix the contract that makes a retry possible: a refusal names
 * what would have worked.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listResolvableRepos, resolveRepo } from './worktree.js';

let tmp: string;

/** A real git repository — `isGitRepositoryRoot` looks for `.git`. */
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args: string[]): void => void execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  run(['init', '-b', 'main']);
  return dir;
}

beforeEach(() => {
  // realpath: macOS hands out /var/… symlinks into /private/var, and this
  // module resolves symlinks by design.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-suggest-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listResolvableRepos', () => {
  it('finds a repository directly under a root', () => {
    initRepo(path.join(tmp, 'saber'));
    expect(listResolvableRepos([tmp])).toEqual(['saber']);
  });

  it('finds a nested one under its owner prefix, the form the tool documents', () => {
    initRepo(path.join(tmp, 'wego', 'saber'));
    expect(listResolvableRepos([tmp])).toEqual(['wego/saber']);
  });

  it('returns every name a caller could have used, sorted', () => {
    initRepo(path.join(tmp, 'saber'));
    initRepo(path.join(tmp, 'wego', 'nanoclaw'));
    expect(listResolvableRepos([tmp])).toEqual(['saber', 'wego/nanoclaw']);
  });

  it('does not descend into a repository, so submodules are not offered', () => {
    // A repository does not contain the repositories a caller would name, and
    // a vendored checkout inside one is not a delegation target.
    const repo = initRepo(path.join(tmp, 'saber'));
    initRepo(path.join(repo, 'vendor', 'inner'));
    expect(listResolvableRepos([tmp])).toEqual(['saber']);
  });

  it('skips dot directories and node_modules', () => {
    initRepo(path.join(tmp, '.cache', 'hidden'));
    initRepo(path.join(tmp, 'node_modules', 'pkg'));
    initRepo(path.join(tmp, 'saber'));
    expect(listResolvableRepos([tmp])).toEqual(['saber']);
  });

  it('follows a symlinked checkout, which is a normal way to lay one out', () => {
    const real = initRepo(path.join(tmp, 'real', 'saber'));
    fs.mkdirSync(path.join(tmp, 'roots'));
    fs.symlinkSync(real, path.join(tmp, 'roots', 'saber'));
    expect(listResolvableRepos([path.join(tmp, 'roots')])).toEqual(['saber']);
  });

  it('ignores a broken symlink rather than naming something that is not there', () => {
    fs.mkdirSync(path.join(tmp, 'roots'));
    fs.symlinkSync(path.join(tmp, 'gone'), path.join(tmp, 'roots', 'saber'));
    expect(listResolvableRepos([path.join(tmp, 'roots')])).toEqual([]);
  });

  it('is empty when nothing resolves, rather than throwing', () => {
    fs.mkdirSync(path.join(tmp, 'not-a-repo'));
    expect(listResolvableRepos([tmp])).toEqual([]);
  });

  it('survives a root that does not exist', () => {
    // This runs while an error is already being built. A second failure here
    // would replace a precise refusal with a stack trace.
    expect(() => listResolvableRepos([path.join(tmp, 'nope')])).not.toThrow();
  });

  it('merges roots and de-duplicates a name they share', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    initRepo(path.join(a, 'saber'));
    initRepo(path.join(b, 'saber'));
    expect(listResolvableRepos([a, b])).toEqual(['saber']);
  });
});

describe('the refusal a mistyped repo gets back', () => {
  it('names the repositories that would have worked', () => {
    initRepo(path.join(tmp, 'saber'));
    initRepo(path.join(tmp, 'wego', 'nanoclaw'));

    expect(() => resolveRepo('sabre', [tmp])).toThrow(/Repositories you can name: saber, wego\/nanoclaw/);
  });

  it('still names the roots, which is what an operator needs', () => {
    initRepo(path.join(tmp, 'saber'));
    expect(() => resolveRepo('sabre', [tmp])).toThrow(new RegExp(`Allowed roots: ${tmp}`));
  });

  it('says so plainly when a root holds no repository at all', () => {
    // "Repositories you can name:" followed by nothing would read as a bug.
    expect(() => resolveRepo('saber', [tmp])).toThrow(/No git repository was found under any of them/);
  });

  it('offers the list when the name resolves to something that is not a repo', () => {
    // The most common near-miss: a directory that exists but was never a
    // checkout. The old message said only that, and left the caller stuck.
    fs.mkdirSync(path.join(tmp, 'saber'));
    initRepo(path.join(tmp, 'nanoclaw'));

    expect(() => resolveRepo('saber', [tmp])).toThrow(/Repositories you can name: nanoclaw/);
  });

  it('keeps saying the allowlist is empty rather than listing nothing', () => {
    // An empty allowlist is an operator configuration problem, not a mistyped
    // name — the caller cannot fix it by retrying, so it must not read as if
    // it could.
    expect(() => resolveRepo('saber', [])).toThrow(/no project roots are configured/);
  });

  it('does not list on a malformed name, which no repository could match', () => {
    initRepo(path.join(tmp, 'saber'));
    // Absolute paths are refused on shape. Naming alternatives here would
    // suggest the shape was the negotiable part.
    expect(() => resolveRepo('/etc', [tmp])).toThrow(/never by absolute path/);
    expect(() => resolveRepo('../x', [tmp])).toThrow(/may not contain/);
  });
});

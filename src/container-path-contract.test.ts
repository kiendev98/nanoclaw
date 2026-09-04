/**
 * The container-path contract, pinned by reading both sides as text.
 *
 * `container/agent-runner/src/roots.ts` names the paths a runner falls back to.
 * `src/drivers/local-driver.ts` maps those same paths to the variables it sets.
 * They must agree, and nothing can make them: the host is Node under pnpm, the
 * runner is Bun under its own tree, and neither imports the other.
 *
 * The failure is silent in one direction. `#deriveRootEnv` drops an
 * unrecognised mount without error, so a root added to `roots.ts` and forgotten
 * here leaves the agent running against a container path that does not exist on
 * the host. A text assertion is ugly and is the only thing that spans the two
 * trees.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const ROOTS = fs.readFileSync(path.join(process.cwd(), 'container/agent-runner/src/roots.ts'), 'utf-8');
const DRIVER = fs.readFileSync(path.join(process.cwd(), 'src/drivers/local-driver.ts'), 'utf-8');

/** Every `root('VAR', '/container/path')` pair the runner declares. */
function declaredRoots(): Array<{ variable: string; containerPath: string }> {
  return [...ROOTS.matchAll(/\broot\(\s*'([A-Z_]+)'\s*,\s*'([^']+)'\s*\)/g)].map((m) => ({
    variable: m[1],
    containerPath: m[2],
  }));
}

describe('container path contract', () => {
  it('declares at least the four roots the driver has to translate', () => {
    // Guards the regex itself: a refactor that renames `root(...)` would
    // otherwise make every assertion below pass against an empty list.
    expect(declaredRoots().length).toBeGreaterThanOrEqual(4);
  });

  it('gives the driver a translation for every root the runner reads', () => {
    for (const { variable, containerPath } of declaredRoots()) {
      const known =
        DRIVER.includes(`'${containerPath}': '${variable}'`) ||
        // `/workspace/extra` is handled by prefix, not by exact path, because
        // its entries are per-session leaves rather than one fixed mount.
        DRIVER.includes(`${containerPath}/`);
      expect(known, `${variable} (${containerPath}) has no translation in local-driver.ts`).toBe(true);
    }
  });

  it('names no variable the runner does not read', () => {
    const declared = new Set(declaredRoots().map((r) => r.variable));
    const mapped = [...DRIVER.matchAll(/'(\/[^']*)': '(NANOCLAW_[A-Z_]+)'/g)].map((m) => m[2]);
    for (const variable of mapped) {
      expect(declared.has(variable), `local-driver.ts sets ${variable}, which roots.ts never reads`).toBe(true);
    }
  });
});

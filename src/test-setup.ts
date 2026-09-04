/**
 * The workspace root defaults to `~/.saber`, a REAL directory on a developer's
 * machine. A suite that touches the central DB would write there, and one such
 * run created an agent group in the live install before this existed.
 *
 * Set at module load, not in `beforeEach`: `workspace.ts` reads the variable
 * once at import, and a test file's module graph loads after its setup files.
 * A test that needs its own root stubs the variable and resets modules.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach } from 'vitest';

if (!process.env.NANOCLAW_WORKSPACE_DIR) {
  const root = path.join(os.tmpdir(), `nanoclaw-test-workspace-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  process.env.NANOCLAW_WORKSPACE_DIR = root;
}

beforeEach(async () => {
  await import('./mailbox/compose.js');
});

/**
 * Attachment paths announced to the agent must resolve through `roots.ts`.
 *
 * `formatAttachments` once emitted the literal `/workspace/${localPath}`,
 * which is right only inside a container. On a host run the file was written
 * correctly and the agent was pointed at a path that does not exist. Nothing
 * raised, and no test failed — the agent simply could not open the file.
 *
 * The root is asserted through `attachmentDisplayPath`'s parameter rather
 * than through the environment. `bunfig.toml` preloads `src/modules/index.ts`,
 * which transitively imports `roots.ts` before any test file runs, so
 * NANOCLAW_WORKSPACE_DIR can never be set from inside a test — every
 * env-based attempt observes the container default and passes against the
 * original bug. `roots.test.ts` pins the defaults themselves.
 */
import { describe, expect, it } from 'bun:test';

import { attachmentDisplayPath } from './formatter.js';
import { WORKSPACE_DIR } from './roots.js';

const RELATIVE_PATH = 'inbox/m-att/photo.jpg';

describe('attachmentDisplayPath', () => {
  it('joins the stored relative path onto a host root', () => {
    expect(attachmentDisplayPath(RELATIVE_PATH, '/srv/state/sess-1')).toBe('/srv/state/sess-1/inbox/m-att/photo.jpg');
  });

  it('does not reach for the container root when another root is given', () => {
    expect(attachmentDisplayPath(RELATIVE_PATH, '/srv/state/sess-1')).not.toContain('/workspace');
  });

  it('joins onto the container root as well', () => {
    expect(attachmentDisplayPath(RELATIVE_PATH, '/workspace')).toBe('/workspace/inbox/m-att/photo.jpg');
  });

  it('defaults to WORKSPACE_DIR so callers never supply a root', () => {
    // What `formatAttachments` relies on: omitting the argument must track
    // roots.ts, not a literal frozen at the call site.
    expect(attachmentDisplayPath(RELATIVE_PATH)).toBe(`${WORKSPACE_DIR}/${RELATIVE_PATH}`);
  });
});

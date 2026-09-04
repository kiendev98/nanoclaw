/**
 * How a group's selected skills reach an agent.
 *
 * Two mechanisms, kept side by side because the difference between them is the
 * whole point. A container resolves `/app/skills` and searches a settings
 * directory the driver mounts; a host process resolves neither, since `HOME`
 * is inherited and `user` scope is the operator's own `~/.claude`.
 *
 * Both are staged for every session. Gating one on the driver would branch on
 * driver identity above the seam, which `drivers/types.ts` forbids: features
 * key on capabilities, never on kind. Staging costs a few symlinks, and the
 * runner decides which route it can actually load.
 *
 * Template skills are a different input and live in `group-skills.ts`: those
 * are stamped per group from a template, these are the shared catalog in
 * `container/skills/`.
 */
import fs from 'fs';
import path from 'path';

import { getGatewayProvider } from './gateway-providers/index.js';
import { log } from './log.js';

import type { ContainerConfig } from './container-config.js';

/**
 * Skills whose prose is only true behind a credential-injecting gateway.
 *
 * `onecli-gateway` tells the agent that a proxy adds real credentials, and it
 * forbids asking the user for a token. Under a gateway that injects nothing
 * the agent follows that instruction into a dead end: a plain 401, no
 * `connect_url`, and no permission to ask. Withhold the skill instead of
 * hedging its text, so what the agent reads matches the runtime it got.
 */
const CREDENTIAL_GATEWAY_SKILLS = new Set(['onecli-gateway']);

/** Whether the install's gateway satisfies this skill's runtime precondition. */
export function skillFitsGateway(skillName: string): boolean {
  return !CREDENTIAL_GATEWAY_SKILLS.has(skillName) || getGatewayProvider().injectsCredentials;
}

/**
 * Stage the shared skills as a loadable plugin in the session workspace.
 *
 * The symlink route below reaches an agent only where a container realizes
 * `/app/skills` AND the settings directory holding those links is one the agent
 * searches. A host driver has neither: nothing resolves `/app`, and `HOME` is
 * inherited so `user` scope is the operator's own `~/.claude`. Every shared
 * skill was therefore absent, in silence, while the composed project document —
 * built from host paths — went on naming those skills.
 *
 * A plugin is a runtime argument rather than a location, so it depends on
 * neither. `roots.ts` derives the path from the session workspace, so this is
 * the only place that has to agree, and no variable carries it.
 *
 * Rebuilt per spawn, so a skill dropped from the selection disappears rather
 * than lingering. Skills are additive: a failure here warns and leaves the
 * session to start without them.
 */
export function stageSkillsPlugin(sessDirPath: string, containerConfig: ContainerConfig): void {
  const dir = path.join(sessDirPath, 'plugin');
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: 'nanoclaw-shared-skills',
          version: '1.0.0',
          description: 'The shared container skills, loaded per session.',
        },
        null,
        2,
      )}\n`,
    );
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const skill of selectedSkillNames(containerConfig)) {
      const src = path.join(sharedSkillsDir, skill);
      if (fs.existsSync(src)) fs.symlinkSync(src, path.join(skillsDir, skill));
    }
  } catch (err) {
    log.warn('Could not stage the shared-skills plugin; session starts without shared skills', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>) so
 * it's dangling on the host but valid inside the container.
 *
 * Not the mechanism the composer stopped using: skill discovery is a directory
 * scan that follows a link wherever it lands, and only `@` imports are gated on
 * resolving inside the project directory.
 */
export function syncSkillSymlinks(claudeDir: string, containerConfig: ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink()) {
      // A real entry here is either a template overlay (intentional; see
      // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
      // the shared skill (#3001). No marker distinguishes them yet, so
      // surface the skip instead of staying silent.
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        {
          skill,
          path: linkPath,
        },
      );
    }
  }
}

/**
 * Resolve the group's skill selection to the names this install can deliver —
 * `'all'` recomputes from `container/skills/` so newly-added upstream skills
 * appear automatically, and a skill the gateway cannot support drops out here.
 *
 * One choke point on purpose: both routes above and every surfaces-providing
 * provider read this list, so the selection cannot disagree with itself.
 */
export function selectedSkillNames(containerConfig: ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills.filter(skillFitsGateway);
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        if (!skillFitsGateway(e)) return false;
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

/**
 * The two privileged actions, decided against a real database.
 *
 * The A6 check runs BEFORE the trust tier in both, and that order is the test
 * worth having: a deny is not something an approval can lift, so a helper that
 * merely held a lower tier could otherwise be carded into delegating.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup, setMessagingGroupDetachedAt } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { registerWorkerMigration } from './db/migrate.js';
import { guard } from '../../guard/index.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { createHelper } from './db/worker-helpers.js';
import { workerDelegate, workerLendConversation } from './guard.js';

const NOW = new Date().toISOString();
const PRINCIPAL = 'ag-principal';
const HELPER = 'ag-helper';
const MESSAGING_GROUP = 'mg-1';

async function makeAgentGroup(id: string, scope: 'group' | 'global'): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: NOW });
  await ensureContainerConfig(id, 'claude');
  await updateContainerConfigScalars(id, { cli_scope: scope });
}

async function makeLentChannel(): Promise<void> {
  await createMessagingGroup({
    id: MESSAGING_GROUP,
    channel_type: 'slack',
    platform_id: 'slack:C123',
    instance: 'slack',
    name: 'ai-anya',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  });
  await createDestination({
    agent_group_id: PRINCIPAL,
    local_name: 'anya',
    target_type: 'channel',
    target_id: MESSAGING_GROUP,
    created_at: NOW,
  });
}

function asAgent(agentGroupId: string, payload: Record<string, unknown> = {}) {
  return { actor: { kind: 'agent' as const, agentGroupId }, payload };
}

beforeEach(async () => {
  registerWorkerMigration();
  await runMigrations(await initTestDb());
  await makeAgentGroup(PRINCIPAL, 'global');
  await makeAgentGroup(HELPER, 'group');
  await createHelper({
    helper_agent_group_id: HELPER,
    principal_agent_group_id: PRINCIPAL,
    repo_name: 'nanoclaw',
    repo_path: '/somewhere/nanoclaw',
    created_at: NOW,
  });
});

afterEach(async () => {
  await closeDb();
});

describe('worker.delegate', () => {
  it('allows a trusted global-scope agent group', async () => {
    const decision = await guard(workerDelegate, asAgent(PRINCIPAL, { repository: 'nanoclaw', task: 'do it' }));
    expect(decision.effect).toBe('allow');
  });

  it('holds a confined agent group for its admin chain', async () => {
    await updateContainerConfigScalars(PRINCIPAL, { cli_scope: 'group' });
    const decision = await guard(workerDelegate, asAgent(PRINCIPAL, { repository: 'nanoclaw', task: 'do it' }));
    expect(decision.effect).toBe('hold');
  });

  it('denies a helper outright, whatever its scope (A6)', async () => {
    await updateContainerConfigScalars(HELPER, { cli_scope: 'global' });
    const decision = await guard(workerDelegate, asAgent(HELPER, { repository: 'saber', task: 'do it' }));
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('one level');
  });

  it('denies an actor that is not an agent', async () => {
    const decision = await guard(workerDelegate, {
      actor: { kind: 'human', userId: 'slack:U1' },
      payload: { repository: 'nanoclaw', task: 'do it' },
    });
    expect(decision.effect).toBe('deny');
  });
});

describe('worker.lend_conversation', () => {
  beforeEach(makeLentChannel);

  it('allows a trusted principal to lend a destination it holds', async () => {
    const decision = await guard(
      workerLendConversation,
      asAgent(PRINCIPAL, { repository: 'nanoclaw', destination: 'anya' }),
    );
    expect(decision.effect).toBe('allow');
  });

  it('denies a destination the caller does not hold (D2)', async () => {
    const decision = await guard(
      workerLendConversation,
      asAgent(PRINCIPAL, { repository: 'nanoclaw', destination: 'someone-elses' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('do not hold');
  });

  it('denies a detached conversation (D11)', async () => {
    await setMessagingGroupDetachedAt(MESSAGING_GROUP, NOW);
    const decision = await guard(
      workerLendConversation,
      asAgent(PRINCIPAL, { repository: 'nanoclaw', destination: 'anya' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('detached');
  });

  it('denies a helper, which holds no conversation of its own', async () => {
    const decision = await guard(
      workerLendConversation,
      asAgent(HELPER, { repository: 'nanoclaw', destination: 'anya' }),
    );
    expect(decision.effect).toBe('deny');
  });
});

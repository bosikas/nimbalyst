// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same hermetic mock surface as MetaAgentService.parentPromotion.test.ts.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      if (i <= 0) {
        throw new Error(`invalid model: ${id}`);
      }
      return { provider: id.slice(0, i), model: id.slice(i + 1), combined: id };
    },
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn(), getSessionState: () => activeTurn }),
}));

vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: (provider: string) =>
    provider === 'antigravity-gemini-agent'
      ? { extensionId: 'antigravity-gemini', contributionId: provider }
      : null,
  isExtensionAgentProvider: (provider: string) => provider === 'antigravity-gemini-agent',
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { database } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';
import { buildClaudeCodeSystemPrompt } from '@nimbalyst/runtime/ai/prompt';

const ROUTED_OWNER = { extensionId: 'com.example.owner', key: 'ada', routeChildUpdatesToOwner: true };
let activeTurn: object = {};

const OWNED_CALLER = {
  id: 'caller',
  provider: 'claude-code',
  model: 'claude-code:opus',
  agentRole: 'standard',
  sessionType: 'session',
  workspacePath: '/workspace/path',
  parentSessionId: 'ws-1',
  metadata: { sessionOwner: ROUTED_OWNER, sessionDirective: 'You are Ada.', ownerMetadata: { chapter: 3 } },
};

function service() {
  const svc = MetaAgentService.getInstance();
  const aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
  (svc as any).aiService = aiService;
  return { svc, aiService };
}

describe('MetaAgentService session ownership', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(AgentMessagesRepository.create).mockReset();
    vi.mocked(database.query).mockClear();
    activeTurn = {};
    (MetaAgentService.getInstance() as any).notificationSignatures.clear();
    (MetaAgentService.getInstance() as any).finalMessagesByTurn.clear();
  });

  it('spawn_session from an owned session writes the owner and notifyParent on the child row itself', async () => {
    const { svc, aiService } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(OWNED_CALLER as any);

    await (svc as any).spawnSession('caller', '/workspace/path', { prompt: 'do the thing' });

    const row = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    // Owner (with its routing opt-in) is inherited; the directive and the
    // owner's per-session bag are not.
    expect(row.metadata).toEqual({
      coordinatorSessionId: 'caller',
      sessionOwner: ROUTED_OWNER,
      notifyParent: false,
      generateSummary: true,
      autoArchiveAfterMinutes: 0,
      instructionSnapshot: null,
      skipDefaultInstructions: false,
    });
    expect(row.createdBySessionId).toBe('caller');
    // Written at creation, before the first prompt exists -- no follow-up write.
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    // (The first prompt goes to the queue, or to a synthetic message in test mode.)
    const firstPrompt = [
      ...aiService.queuePromptForSession.mock.invocationCallOrder,
      ...vi.mocked(AgentMessagesRepository.create).mock.invocationCallOrder,
    ];
    expect(firstPrompt).toHaveLength(1);
    expect(vi.mocked(AISessionsRepository.create).mock.invocationCallOrder[0]).toBeLessThan(firstPrompt[0]);
  });

  it('refuses to create the child when the caller\'s ownership cannot be read', async () => {
    const { svc } = service();
    // The spawn's own parent check succeeds; the ownership read then fails.
    vi.mocked(AISessionsRepository.get)
      .mockResolvedValueOnce(OWNED_CALLER as any)
      .mockRejectedValueOnce(new Error('database busy'));

    await expect((svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x' })).rejects.toThrow(/database busy/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('an unowned notify-on-complete spawn carries no owner and no notifyParent opt-out', async () => {
    const { svc } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);

    await (svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x', notifyOnComplete: true });

    const metadata = (vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any).metadata;
    expect(metadata).toEqual({
      coordinatorSessionId: 'caller',
      sessionDirective: expect.any(String),
      generateSummary: true,
      autoArchiveAfterMinutes: 0,
      instructionSnapshot: null,
      skipDefaultInstructions: false,
    });
  });

  describe('child reporting', () => {
    // The child's real system prompt for each spawn setting, so a wording change
    // that tells a quiet child to message its parent shows up here.
    async function childPrompt(spawnArgs: Record<string, unknown>, via: 'spawnSession' | 'createChildSession' = 'spawnSession') {
      const { svc } = service();
      vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);
      await (svc as any)[via]('caller', '/workspace/path', { prompt: 'x', ...spawnArgs });
      const metadata = (vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any).metadata;
      return { metadata, prompt: buildClaudeCodeSystemPrompt({ hasSessionNaming: true, sessionDirective: metadata.sessionDirective }) };
    }

    it('none (the default for spawn_session and create_session) adds nothing and suppresses the completion notification', async () => {
      for (const via of ['spawnSession', 'createChildSession'] as const) {
        vi.mocked(AISessionsRepository.create).mockReset();
        const { metadata, prompt } = await childPrompt({}, via);
        expect(metadata).toEqual({
          ...(via === 'spawnSession' && { coordinatorSessionId: 'caller' }),
          notifyParent: false,
          generateSummary: true,
          autoArchiveAfterMinutes: 0,
          instructionSnapshot: null,
          skipDefaultInstructions: false,
        });
        expect(prompt).toBe(buildClaudeCodeSystemPrompt({ hasSessionNaming: true }));
        expect(prompt).not.toMatch(/send_prompt|messageKind|consume_session_inbox|sibling/);
      }
    });

    it('final makes the final response the report and asks for no messages', async () => {
      const { metadata, prompt } = await childPrompt({ reporting: 'final' });
      expect(metadata.notifyParent).toBeUndefined();
      expect(prompt.slice(prompt.indexOf('Your final response'))).toMatchInlineSnapshot(`
        "Your final response is delivered to the session that started you (caller) as your report. Do not send it status or acknowledgement messages.

        </addendum>
        "
      `);
    });

    it('messages is the only setting that mentions send_prompt, and defers to the brief', async () => {
      const { metadata, prompt } = await childPrompt({ reporting: 'messages' });
      expect(metadata.notifyParent).toBeUndefined();
      expect(prompt.slice(prompt.indexOf('The session that started you'))).toMatchInlineSnapshot(`
        "The session that started you (caller) asked for reports: send each material change once with send_prompt messageKind=report, unless your brief says otherwise. Your final response is delivered to it automatically.

        </addendum>
        "
      `);
    });

    it('rejects an unknown setting before creating anything', async () => {
      const { svc } = service();
      vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);
      await expect((svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x', reporting: 'chatty' })).rejects.toThrow(/Invalid reporting/);
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
    });
  });

  it('a report to an idle session is queued without waking it; an instruction still wakes it', async () => {
    const { svc, aiService } = service();
    vi.spyOn(svc as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    vi.spyOn(svc as any, 'getSessionStatusRow').mockResolvedValue({ status: 'idle' });
    aiService.queuePromptForSession.mockResolvedValue({ id: 'q1', prompt: 'p' });
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ id: 'parent', workspacePath: '/workspace/path' } as any);

    const report = JSON.parse(await (svc as any).sendPromptToSession('child', 'parent', '/workspace/path', 'paths released', false, 'report'));
    expect(report).toMatchObject({ processingTriggered: false, heldForNextTurn: true });
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();

    await (svc as any).sendPromptToSession('child', 'parent', '/workspace/path', 'do this next', false, 'instruction');
    expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
  });

  function settleHarness(coordinatorSessionId: string | null, metadata?: Record<string, unknown>) {
    const { svc, aiService } = service();
    const child = {
      id: 'child',
      createdBySessionId: 'spawner',
      coordinatorSessionId,
      metadata,
      workspacePath: '/workspace/path',
    };
    vi.mocked(AISessionsRepository.get).mockImplementation(async id => (
      id === child.id ? child : { id, workspacePath: child.workspacePath }
    ) as any);
    vi.spyOn(svc as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    vi.spyOn(svc as any, 'getSessionStatusRow').mockResolvedValue({ status: 'idle' });
    vi.spyOn(svc as any, 'buildSessionResultData').mockResolvedValue({
      sessionId: 'child', title: 'Worker', status: 'idle', recentMessages: [], editedFiles: [],
    });
    aiService.queuePromptForSession.mockResolvedValue({ id: 'q1', prompt: 'p' });
    return { svc: svc as any, aiService, workspace: child.workspacePath };
  }

  it.each([[null, 'spawner'], ['coordinator', 'coordinator']])(
    'routes the completion with coordinator %s only to %s',
    async (coordinatorId, recipient) => {
      const { svc, aiService, workspace } = settleHarness(coordinatorId);
      await svc.handleChildSessionEvent('child', 'session:completed');
      expect(aiService.queuePromptForSession).toHaveBeenCalledExactlyOnceWith(
        recipient, expect.stringMatching(/^\[Child Session Update\]/), undefined,
        { promptProvenance: { actor: 'agent', origin: 'child-session-update', messageKind: 'report', originSessionId: 'child' } },
      );
      expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(recipient, workspace, 'meta-agent');
    },
  );

  it('routes a quiet worker to an explicitly assigned coordinator', async () => {
    const { svc, aiService } = settleHarness('coordinator', { notifyParent: false, notifyCoordinator: true });
    await svc.handleChildSessionEvent('child', 'session:completed');
    expect(aiService.queuePromptForSession).toHaveBeenCalledExactlyOnceWith(
      'coordinator', expect.stringMatching(/^\[Child Session Update\]/), undefined, expect.any(Object),
    );
  });

  it('wakes an idle coordinator for a final result and skips its automatic update', async () => {
    const { svc, aiService, workspace } = settleHarness('coordinator');
    await svc.sendPromptToSession('child', 'coordinator', workspace, 'Done', false, 'final');
    await svc.handleChildSessionEvent('child', 'session:completed');
    expect(aiService.queuePromptForSession).toHaveBeenCalledExactlyOnceWith(
      'coordinator', 'Done', undefined,
      { promptProvenance: { actor: 'agent', origin: 'session-orchestration', messageKind: 'final', originSessionId: 'child' } },
    );
    expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledExactlyOnceWith('coordinator', workspace, 'meta-agent');
  });

  it('still sends the automatic update when a final went to a different session', async () => {
    const { svc, aiService, workspace } = settleHarness('coordinator');
    await svc.sendPromptToSession('child', 'spawner', workspace, 'Done', false, 'final');
    await svc.handleChildSessionEvent('child', 'session:completed');
    expect(aiService.queuePromptForSession).toHaveBeenCalledTimes(2);
    expect(aiService.queuePromptForSession).toHaveBeenLastCalledWith(
      'coordinator', expect.stringMatching(/^\[Child Session Update\]/), undefined, expect.any(Object),
    );
  });

  it('assigns, transfers, and clears the coordinator before queueing the instruction', async () => {
    const { svc, aiService, workspace } = settleHarness('spawner');
    await svc.sendPromptToSession('coordinator', 'child', workspace, 'Continue', false, 'instruction', true);
    await svc.sendPromptToSession('other', 'child', workspace, 'Continue', false, 'instruction', true);
    await svc.sendPromptToSession('other', 'child', workspace, 'Continue', false, 'instruction', false);
    expect(AISessionsRepository.updateMetadata).toHaveBeenNthCalledWith(1, 'child', { metadata: { coordinatorSessionId: 'coordinator', notifyCoordinator: true } });
    expect(AISessionsRepository.updateMetadata).toHaveBeenNthCalledWith(2, 'child', { metadata: { coordinatorSessionId: 'other', notifyCoordinator: true } });
    expect(AISessionsRepository.updateMetadata).toHaveBeenNthCalledWith(3, 'child', { metadata: { coordinatorSessionId: null, notifyCoordinator: false } });
    expect(vi.mocked(AISessionsRepository.updateMetadata).mock.invocationCallOrder[0]).toBeLessThan(
      aiService.queuePromptForSession.mock.invocationCallOrder[0],
    );
  });

  it('an owner-routed child settle queues no [Child Session Update] on the parent', async () => {
    const { svc, aiService } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'child',
      agentRole: 'standard',
      createdBySessionId: 'caller',
      workspacePath: '/workspace/path',
      metadata: { sessionOwner: ROUTED_OWNER },
    } as any);

    for (const type of ['session:completed', 'session:waiting', 'session:error', 'session:interrupted']) {
      await (svc as any).handleChildSessionEvent('child', type);
    }

    expect(aiService.queuePromptForSession).not.toHaveBeenCalled();
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });
});

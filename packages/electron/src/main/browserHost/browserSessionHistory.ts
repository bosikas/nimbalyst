import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { partitionUnansweredQuestions } from '@nimbalyst/runtime/ai/server/interactivePromptTools';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { database } from '../database/PGLiteDatabaseWorker';
import { createWorktreeStore } from '../services/WorktreeStore';
import { findWindowByWorkspace } from '../window/WindowManager';
import { getQueuedPromptsStore } from '../services/RepositoryManager';
import { getSessionContextInspection } from '../mcp/sessionContextInspection';
import { invokeBrowserPanelCommand, type BrowserPanelCommand } from './browserPanelCommands';

const formResponseSchema = z.object({
  answers: z.record(z.string(), z.discriminatedUnion('type', [
    z.object({ type: z.literal('multiSelect'), selectedIds: z.array(z.string()) }),
    z.object({ type: z.literal('singleSelect'), selectedId: z.string(), otherText: z.string().optional() }),
    z.object({ type: z.literal('reorder'), orderedIds: z.array(z.string()), removedIds: z.array(z.string()) }),
    z.object({ type: z.literal('editText'), text: z.string(), edited: z.boolean() }),
    z.object({ type: z.literal('confirm'), value: z.boolean() }),
  ])),
  cancelled: z.boolean(),
});

export async function invokeBrowserSessionHistory(
  workspacePath: string, channel: string, args: unknown[], defaultProvider: unknown,
) {
  const [first, second, third] = args;
  function invoke(command: BrowserPanelCommand, ...params: unknown[]) {
    const owner = findWindowByWorkspace(workspacePath);
    if (!owner || owner.isDestroyed()) throw new Error('Open this workspace on the Linux host to use its session controls');
    return invokeBrowserPanelCommand(command, owner.webContents, params);
  }

  async function requireWorkspaceSession(id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Invalid session ID');
    const session = await AISessionsRepository.get(id);
    if (session?.workspacePath !== workspacePath) throw new Error('Session not found in this workspace');
    return { id, session };
  }

  async function requireSession(id: unknown) {
    return (await requireWorkspaceSession(id)).id;
  }

  async function requireOpenQuestion(sessionId: unknown, promptId: unknown, ...toolNames: string[]) {
    if (typeof promptId !== 'string' || !promptId || promptId.length > 512) {
      throw new Error('Invalid question ID');
    }
    const { id, session } = await requireWorkspaceSession(sessionId);
    const messages = await TranscriptMigrationRepository.getService().getViewMessages(id, session.provider);
    const { open } = partitionUnansweredQuestions(messages);
    if (!open.some((question) => question.id === promptId && toolNames.includes(question.toolName))) {
      throw new Error('Question is no longer pending');
    }
    return id;
  }

  switch (channel) {
    case 'claude-code:answer-question':
    case 'claude-code:cancel-question': {
      const { sessionId, questionId, answers } = (first ?? {}) as {
        sessionId?: unknown; questionId?: unknown; answers?: unknown;
      };
      if (channel === 'claude-code:answer-question' &&
          (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
           Object.values(answers).some((value) => typeof value !== 'string'))) {
        throw new Error('Invalid question answers');
      }
      const id = await requireOpenQuestion(sessionId, questionId, 'AskUserQuestion');
      return invoke(channel, channel === 'claude-code:answer-question'
        ? { sessionId: id, questionId, answers }
        : { sessionId: id, questionId });
    }
    case 'messages:respond-to-prompt': {
      const { sessionId, promptId, promptType, response } = (first ?? {}) as {
        sessionId?: unknown; promptId?: unknown; promptType?: unknown; response?: unknown;
      };
      if (promptType !== 'request_user_input_request') {
        throw new Error('This interactive prompt is unavailable in the browser');
      }
      const parsed = formResponseSchema.safeParse(response);
      if (!parsed.success) throw new Error('Invalid form response');
      const id = await requireOpenQuestion(sessionId, promptId, 'PromptForUserInput', 'RequestUserInput');
      return invoke(channel, { sessionId: id, promptId, promptType, response: parsed.data, respondedBy: 'desktop' });
    }
    case 'mcp-config:get-context-inspection':
      return getSessionContextInspection(await requireSession(first), workspacePath, { audience: 'browser' });
    case 'ai:getModels':
      return invoke(channel);
    case 'action-prompts:list':
      if ((first as { workspacePath?: unknown } | undefined)?.workspacePath !== workspacePath) throw new Error('Invalid workspace');
      return invoke(channel, { workspacePath });
    case 'ai:compactSession':
      return invoke(channel, await requireSession(first));
    case 'ai:sendQueuedVibePromptNow':
      return invoke(channel, await requireSession(first), second);
    case 'ai:deleteQueuedPrompt': {
      if (typeof first !== 'string' || first.length > 128) throw new Error('Invalid queued prompt');
      const prompt = await getQueuedPromptsStore().get(first);
      await requireSession(prompt?.sessionId);
      return invoke(channel, first);
    }
    case 'sessions:search': {
      if (first !== workspacePath || typeof second !== 'string' || !second.trim() || second.length > 1000) {
        throw new Error('Invalid session search');
      }
      const options = third as { includeArchived?: unknown; timeRange?: unknown; direction?: unknown } | undefined;
      return invoke(channel, workspacePath, second.trim(), {
        includeArchived: options?.includeArchived === true,
        timeRange: options?.timeRange === '7d' || options?.timeRange === '30d' || options?.timeRange === '90d'
          ? options.timeRange : 'all',
        direction: options?.direction === 'input' || options?.direction === 'output' ? options.direction : 'all',
      });
    }
    case 'sessions:create': {
      const id = randomUUID();
      return invoke(channel, {
        workspaceId: workspacePath,
        session: { id, provider: defaultProvider, title: 'New Session' },
        launchSource: 'session_history',
      });
    }
    case 'sessions:create-child':
      return invoke(channel, { parentSessionId: await requireSession(first), workspacePath, provider: defaultProvider });
    case 'sessions:update-title':
      if (typeof second !== 'string' || !second.trim() || second.length > 500) throw new Error('Invalid session title');
      return invoke(channel, await requireSession(first), second.trim());
    case 'sessions:update-pinned':
      if (typeof second !== 'boolean') throw new Error('Invalid pin change');
      return invoke(channel, await requireSession(first), second);
    case 'sessions:update-session-metadata': {
      const tags = (second as { tags?: unknown } | undefined)?.tags;
      if (!Array.isArray(tags) || tags.length > 100 || !tags.every(
        (tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 120,
      )) throw new Error('Invalid session tags');
      return invoke(channel, await requireSession(first), { tags });
    }
    case 'sessions:update-metadata': {
      const input = second as { title?: unknown; isArchived?: unknown; mode?: unknown; model?: unknown; metadata?: Record<string, unknown> } | undefined;
      const updates: Record<string, unknown> = {};
      if (typeof input?.title === 'string' && input.title.trim() && input.title.trim().length <= 500) {
        updates.title = input.title.trim();
      }
      if (typeof input?.isArchived === 'boolean') updates.isArchived = input.isArchived;
      if (input?.mode === 'agent' || input?.mode === 'planning') updates.mode = input.mode;
      if (typeof input?.model === 'string' && /^[\w.-]+:[\w.:/-]{1,180}$/.test(input.model)) updates.model = input.model;
      const fields = Object.entries(input?.metadata ?? {}).filter(([key, value]) =>
        ['effortLevel', 'thinkingMode', 'opencodeAgent'].includes(key) &&
        (value === null || (typeof value === 'string' && value.length <= 80)));
      if (fields.length) updates.metadata = Object.fromEntries(fields);
      if (!Object.keys(updates).length) throw new Error('Invalid session change');
      return invoke(channel, await requireSession(first), updates);
    }
    case 'sessions:list-children':
      if (second !== workspacePath) throw new Error('Invalid workspace');
      return invoke(channel, await requireSession(first), workspacePath, {
        includeArchived: (third as { includeArchived?: unknown } | undefined)?.includeArchived === true,
      });
    case 'worktree:get-batch': {
      if (!Array.isArray(first) || first.length > 500 || first.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid worktree IDs');
      }
      const requested = new Set(first);
      const local = await createWorktreeStore(database).list(workspacePath);
      return invoke(channel, local.map(({ id }) => id).filter((id) => requested.has(id)));
    }
    case 'worktree:update-pinned': {
      if (typeof first !== 'string' || !first || first.length > 128 || typeof second !== 'boolean') {
        throw new Error('Invalid worktree pin change');
      }
      const worktree = await createWorktreeStore(database).get(first);
      if (worktree?.projectPath !== workspacePath) throw new Error('Worktree not found in this workspace');
      return invoke(channel, first, second);
    }
    default:
      throw new Error('This desktop command is unavailable in browser Sessions');
  }
}

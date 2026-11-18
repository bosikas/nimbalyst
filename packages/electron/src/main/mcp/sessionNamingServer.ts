/**
 * Session-naming / `update_session_meta` tool surface.
 *
 * MCP consolidation: `update_session_meta` is served by the unified internal MCP
 * HTTP server's eager core (`/mcp/core`, `nimbalyst`). This module exports the
 * dynamic schema builder + an endpoint-agnostic dispatch fn, and keeps the
 * setter-injected session-manager fns (the auto-namer also calls them); the
 * standalone HTTP server it used to run was retired in Phase 7.
 */

import { instructionTemplate } from '@nimbalyst/runtime/ai/instructionTemplates';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

let updateSessionSummaryFn: ((sessionId: string, args: unknown) => Promise<string>) | undefined;
export function setUpdateSessionSummaryFn(fn: NonNullable<typeof updateSessionSummaryFn>): void {
  updateSessionSummaryFn = fn;
}

// Store reference to the session manager functions (set once at startup)
let updateSessionTitleFn:
  | ((sessionId: string, title: string) => Promise<void>)
  | null = null;

let updateSessionMetadataFn:
  | ((sessionId: string, metadata: Record<string, unknown>) => Promise<void>)
  | null = null;

let getSessionTagsFn:
  | ((sessionId: string) => Promise<string[]>)
  | null = null;

let getSessionTitleFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

let getSessionPhaseFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

/**
 * Set the update function for session titles (called once at startup)
 */
export function setUpdateSessionTitleFn(
  updateTitleFn: (sessionId: string, title: string) => Promise<void>
) {
  updateSessionTitleFn = updateTitleFn;
}

/**
 * Set the update function for session metadata (called once at startup)
 */
export function setUpdateSessionMetadataFn(
  updateMetadataFn: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>
) {
  updateSessionMetadataFn = updateMetadataFn;
}

/**
 * Set the function to get current tags for a session (called once at startup)
 */
export function setGetSessionTagsFn(
  getTagsFn: (sessionId: string) => Promise<string[]>
) {
  getSessionTagsFn = getTagsFn;
}

/**
 * Set the function to get current title for a session (called once at startup)
 */
export function setGetSessionTitleFn(
  getTitleFn: (sessionId: string) => Promise<string | null>
) {
  getSessionTitleFn = getTitleFn;
}

/**
 * Set the function to get current phase for a session (called once at startup)
 */
export function setGetSessionPhaseFn(
  getPhaseFn: (sessionId: string) => Promise<string | null>
) {
  getSessionPhaseFn = getPhaseFn;
}

// ─── Shared tool surface (served by the unified MCP server) ─────────
//
// `update_session_meta` rides on the eager core (`nimbalyst`) served by the
// unified internal HTTP server's `/mcp/core` endpoint. The dispatch + schema
// builder below are the single implementation; the IPC side effects live in the
// injected fns above.

/**
 * Build the `update_session_meta` tool schema. This eager schema must remain
 * byte-stable for the lifetime of a Claude cache lineage: embedding live
 * workspace tag names, counts, or count-derived ordering here turns ordinary
 * tag updates into a full `tools_changed` cache miss.
 */
export async function buildSessionMetaToolSchemas(_aiSessionId: string): Promise<any[]> {
  return [
    {
      name: "update_session_meta",
      description:
        instructionTemplate('metadata-tool.description'),
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              instructionTemplate('metadata-tool.name'),
          },
          add: {
            type: "array",
            items: { type: "string" },
            description: instructionTemplate('metadata-tool.add'),
          },
          remove: {
            type: "array",
            items: { type: "string" },
            description: instructionTemplate('metadata-tool.remove'),
          },
          phase: {
            type: "string",
            enum: ["backlog", "planning", "implementing", "validating", "complete"],
            description:
              instructionTemplate('metadata-tool.phase'),
          },
          workflowPreset: {
            type: "string",
            enum: ["default", "implement-review-test", "research"],
            description:
              instructionTemplate('metadata-tool.workflow-preset'),
          },
        },
      },
    },
    {
      name: 'update_session_summary',
      description: instructionTemplate('metadata-tool.summary-description'),
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['scope', 'remaining', 'attention', 'areas'],
        properties: {
          scope: { type: 'string', maxLength: 220, description: instructionTemplate('metadata-tool.scope') },
          remaining: { type: 'string', maxLength: 280, description: instructionTemplate('metadata-tool.remaining') },
          attention: { type: 'string', enum: ['next', 'blocked', 'review', 'none', 'unknown'] },
          areas: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
        },
      },
    },
  ];
}

/** Snapshot the current session metadata state (uses the injected getter fns). */
async function snapshotSessionMeta(aiSessionId: string): Promise<{ name: string | null; tags: string[]; phase: string | null }> {
  const name = getSessionTitleFn ? await getSessionTitleFn(aiSessionId) : null;
  const tags: string[] = getSessionTagsFn ? await getSessionTagsFn(aiSessionId) : [];
  const phase = getSessionPhaseFn ? await getSessionPhaseFn(aiSessionId) : null;
  return { name, tags, phase };
}

/** Build the structured JSON response with before/after state for the widget. */
function buildSessionMetaResponse(
  notes: string[],
  before: { name: string | null; tags: string[]; phase: string | null },
  after: { name: string | null; tags: string[]; phase: string | null },
): string {
  const parts = [...notes];
  parts.push(`Name: ${after.name || '(not set)'}`);
  parts.push(instructionTemplate('metadata-tool.tags-response', [after.tags.length > 0 ? after.tags.map(t => `#${t}`).join(', ') : '(none)']));
  parts.push(`Phase: ${after.phase || '(not set)'}`);
  const summary = parts.join('\n');
  return JSON.stringify({ summary, before, after });
}

/**
 * Dispatch `update_session_meta` and return the MCP `{content, isError}` shape.
 * `name` may carry the `mcp__nimbalyst__` prefix; it is stripped. The injected
 * fns perform the DB writes + IPC broadcasts (session-updated / title-updated),
 * so the kanban/UI still updates.
 */
export async function dispatchSessionMetaTool(
  name: string,
  args: Record<string, any> | undefined,
  aiSessionId: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const toolName = name.replace(/^mcp__nimbalyst(-session-naming)?__/, "");

  try {
    if (toolName === 'update_session_summary') {
      try {
        if (!updateSessionSummaryFn) throw new Error('Session summaries are not available.');
        return { content: [{ type: 'text', text: await updateSessionSummaryFn(aiSessionId, args) }], isError: false };
      } catch (error) {
        return { content: [{ type: 'text', text: instructionTemplate('metadata-tool.summary-error', [error instanceof Error ? error.message.slice(0, 240) : 'Invalid submission.']) }], isError: true };
      }
    }
    if (toolName === "update_session_meta") {
      const sessionName = args?.name as string | undefined;
      const addTags = Array.isArray(args?.add) ? args.add as string[] : typeof args?.add === 'string' ? [args.add] : undefined;
      const removeTags = Array.isArray(args?.remove) ? args.remove as string[] : typeof args?.remove === 'string' ? [args.remove] : undefined;
      const phase = args?.phase as string | undefined;
      const rawWorkflowPreset = args?.workflowPreset;
      const workflowPreset =
        rawWorkflowPreset === 'default' ||
        rawWorkflowPreset === 'implement-review-test' ||
        rawWorkflowPreset === 'research'
          ? (rawWorkflowPreset as string)
          : undefined;
      if (rawWorkflowPreset !== undefined && workflowPreset === undefined) {
        return {
          content: [
            {
              type: "text",
              text: instructionTemplate('metadata-tool.workflow-error'),
            },
          ],
          isError: true,
        };
      }

      // Require at least one parameter
      if (!sessionName && !addTags?.length && !removeTags?.length && !phase && !workflowPreset) {
        return {
          content: [
            {
              type: "text",
              text: instructionTemplate('metadata-tool.empty-error'),
            },
          ],
          isError: true,
        };
      }

      // Capture state before changes for the widget transition display
      const before = await snapshotSessionMeta(aiSessionId);
      const notes: string[] = [];

      // Explicit names may be initial assignments or user-requested renames.
      if (sessionName) {
        if (typeof sessionName !== "string") {
          return {
            content: [
              {
                type: "text",
                text: 'Error: "name" must be a string.',
              },
            ],
            isError: true,
          };
        }

        if (sessionName.length > 100) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Session name too long (${sessionName.length} chars, max 100)`,
              },
            ],
            isError: true,
          };
        }

        try {
          // The host also marks the session named; matching provisional text
          // alone does not make an explicit first assignment a no-op.
          await updateSessionTitleFn!(aiSessionId, sessionName);
          notes.push(`Set name: "${sessionName}"`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          console.error("[Session Naming MCP] Failed to update session title:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating session title: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Handle tags (add/remove)
      if (addTags?.length || removeTags?.length) {
        if (!updateSessionMetadataFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Session metadata update not available.",
              },
            ],
            isError: true,
          };
        }

        try {
          const currentTags: string[] = getSessionTagsFn
            ? await getSessionTagsFn(aiSessionId)
            : [];

          let newTags = [...currentTags];
          if (removeTags?.length) {
            const removeSet = new Set(removeTags);
            newTags = newTags.filter(t => !removeSet.has(t));
          }
          if (addTags?.length) {
            for (const tag of addTags) {
              if (!newTags.includes(tag)) {
                newTags.push(tag);
              }
            }
          }

          const metadataUpdate: Record<string, unknown> = {};
          if (!getSessionTagsFn || newTags.length !== currentTags.length || newTags.some((tag, index) => tag !== currentTags[index])) metadataUpdate.tags = newTags;
          if (phase && (!getSessionPhaseFn || phase !== before.phase)) metadataUpdate.phase = phase;
          if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;

          if (Object.keys(metadataUpdate).length) await updateSessionMetadataFn(aiSessionId, metadataUpdate);

          const added = newTags.filter(tag => !currentTags.includes(tag));
          const removed = currentTags.filter(tag => !newTags.includes(tag));
          if (added.length) notes.push(`Added tags: ${added.map(t => `#${t}`).join(', ')}`);
          if (removed.length) notes.push(`Removed tags: ${removed.map(t => `#${t}`).join(', ')}`);
          if (metadataUpdate.phase) notes.push(`Set phase: ${phase}`);
        } catch (error) {
          console.error("[Session Naming MCP] Failed to update tags:", error);
          return {
            content: [
              {
                type: "text",
                text: instructionTemplate('metadata-tool.tags-error', [error instanceof Error ? error.message : "Unknown error"]),
              },
            ],
            isError: true,
          };
        }
      } else if (phase || workflowPreset) {
        // Metadata-only update (no tag changes): phase and/or workflowPreset
        if (!updateSessionMetadataFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Session metadata update not available.",
              },
            ],
            isError: true,
          };
        }

        try {
          const metadataUpdate: Record<string, unknown> = {};
          if (phase && (!getSessionPhaseFn || phase !== before.phase)) metadataUpdate.phase = phase;
          if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;
          if (Object.keys(metadataUpdate).length) await updateSessionMetadataFn(aiSessionId, metadataUpdate);
          if (metadataUpdate.phase) notes.push(`Set phase: ${phase}`);
          if (workflowPreset) notes.push(`Set workflow preset: ${workflowPreset}`);
        } catch (error) {
          console.error("[Session Naming MCP] Failed to update session metadata:", error);
          return {
            content: [
              {
                type: "text",
                text: instructionTemplate('metadata-tool.update-error', [error instanceof Error ? error.message : "Unknown error"]),
              },
            ],
            isError: true,
          };
        }
      }

      // Build structured response with before/after for widget
      const after = await snapshotSessionMeta(aiSessionId);
      const response = buildSessionMetaResponse(notes, before, after);
      return {
        content: [{ type: "text", text: response }],
        isError: false,
      };
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`[SessionMeta MCP] Tool "${name}" failed:`, error);
    console.error(`[SessionMeta MCP] Tool args:`, JSON.stringify(args).slice(0, 500));
    throw error;
  }
}

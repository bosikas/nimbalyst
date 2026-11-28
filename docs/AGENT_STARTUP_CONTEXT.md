# Agent startup context

Keep startup boundaries short and load procedures through relevant skills. Provider baselines, Nimbalyst integration rules, repository instructions, selected session profiles and opening input have distinct owners. A local log is evidence of recorded state, not necessarily the complete outbound request.

## Edit instruction sources in Agent setup

Settings → Agent setup → Instructions can edit or select a Markdown source for each Nimbalyst guidance section. Saved replacements live in versioned `.md` files under the application's user-data `agent-guidance` directory; settings retain source paths and enabled flags. The panel shows each selected path and reloads its current contents. Prompt assembly reads selected files again, so external edits affect future prompts. Conditional sections still apply only in their existing contexts. Start a fresh session after changing guidance to avoid conflicting instructions retained in earlier history.

Saving creates a new file and changes the selected path. It preserves previous versions and never overwrites a selected repository file. Reset clears the selection and preserves the file. Existing custom prose in settings migrates into Markdown files with a recoverable JSON backup. Missing, empty, invalid UTF-8, nonregular or oversized selected files produce errors instead of silently replacing enabled custom instructions with defaults; the panel remains available to choose another source, disable the section or reset it.

Nimbalyst's shipped prompt text, including the metadata tool descriptions changed here, comes from [defaults.json](../packages/runtime/src/ai/instructions/defaults.json), rendered by a single-pass interpolation helper. TypeScript retains conditional assembly and dynamic values. These packaged defaults require a rebuild when edited in the repository; user-selected Markdown sources are read at runtime. At the extraction checkpoint, ten previously rendered Claude, Codex, coordinator and extension-agent variants had identical output. Subsequent authorization and lifecycle repairs intentionally change those instructions and have separate tests.

## Conflict boundaries and existing skill triggers

Coordinator instructions now bound child approvals to the delegated task, preserve the user's delivery scope, wait for submitted answers to blocking questions and pass those answers back to the child. Caller-assigned titles are respected even by the optional Codex reminder. Claude guidance also distinguishes available delegation tools from permission to delegate. The coordinator's shared-workspace instructions match `create_session`: it does not create isolated child worktrees, so concurrent children need disjoint file ownership. Native meta-agent notification delivery still ends and resumes coordinator turns.

The skill audit found no safe additional procedure deferral to enable globally. Built-in production providers do not pass the legacy `planTrackingEnabled` prompt option; real planning procedures already arrive through the applicable plugin skill. Agent setup labels that legacy section accordingly. A proposed skill-pointer option was removed because it would have been unreachable. Coordinator, chat and tool-loop agents have no always-available matching skill, and repository-only commands cannot be assumed in arbitrary workspaces. Their essential procedures remain inline; no compression or behavior benefit is claimed from moving prose into source files.

The Codex base prompt has its own editor and Markdown source selector. Without a selection, Codex chooses its provider-owned default; Nimbalyst does not supply or display a fabricated copy. A selected file replaces the base through the app-server's `thread/start.baseInstructions`, while Nimbalyst integration guidance remains `developerInstructions`. Live threads and resumed threads retain their original base; global edits are not sent through `thread/resume`. Configuring a custom base with the legacy SDK transport produces an explicit unsupported error. Permissions, approval review, native tool contracts and repository instructions remain independently configured.

The Effective setup tab previews the selected custom Codex base separately from Nimbalyst additions for a new thread. It is a configuration preview, not a capture of the base in an existing thread or proof of outbound delivery. The installed Codex 0.167.0 accepted a custom base in a validation-only `thread/start` without a model turn. It did not persist that empty thread; real-binary resume retention has not been observed. Protocol tests cover omission of the override during resume.

## Inspect recorded native startup

In the token meter, choose **Inspect context** to open the dialog. **Recorded native startup: messages and audit snapshots** reads the local Codex startup log for the session's native thread and keeps recorded evidence separate from the prepared request and provider-reported usage. Missing files, unsupported older thread identifiers and read errors remain explicit. The lookup checks the UUIDv7 creation-day directory and its adjacent days. Archived or moved rollouts may be unavailable.

Mistral Vibe uses the same inspector for ACP request measurements, saved startup instructions, and a bounded view of retained conversation, including tool call arguments and results. The model label follows the Nimbalyst session selection. Saved checkpoints keep these records available after app restarts, while measurements of the latest ACP request come from the current process. The authenticated browser inspector can read the records for the connected workspace. Agent tools receive measurements without the raw text.

For **Claude Agent** and **Claude Code CLI**, the same dialog shows the first user message in the available transcript and provider-reported context categories when present. Claude Agent also shows the last turn's Nimbalyst prompt additions captured in the current app window. Claude’s built-in system prompt and native instruction text are unavailable in the inspector.

For an offline HTML report, run `node scripts/manual-tests/agent-startup-context/inspect.mjs /absolute/path/to/rollout.jsonl /absolute/path/to/new-report.html` with Node 22.18+ (native TypeScript stripping). The destination must not exist. The local HTML report contains prompt text; keep it private. No transcript or provider configuration is changed, and no model request is made. Both inspectors share the same pure parser.

The inspector stops at the first record marked `user.text` or a tool-delivered opening input. Those labels identify transport records, not independent proof of human authorship: an approval-review request can also be machine-generated user-role text. It separates recorded messages, tool definitions and audit snapshots, including native state, `turn_context` and `thread_settings_applied`. A base instruction stored in `session_meta` and repeated in one developer message is marked as an overlapping representation, not two messages. Identical message records remain visible; repetition in a log alone does not establish repeated outbound delivery. Missing native provenance or opening input remains explicit. UTF-8 bytes are never converted to tokens or advertised as savings.

Raw reads are bounded to a 4 MB startup prefix plus one byte before decoding lines, including files with no newline. The main-process reader rejects nonregular files, invalid UTF-8/JSON and mismatched native thread identifiers. Displayed message text may be capped at 64 KB with a visible label; totals and fingerprints cover the complete parsed record. React renders log text literally. The original main and guardian logs retain their respective 7 / 40,161 and 4 / 29,561 message-count / UTF-8-text-byte totals; each now shows four excluded snapshots.

Inspect guardian rollouts separately. `source.subagent.other = guardian` identifies the automatic approval reviewer; it is a separate conversation with its own baseline, not a duplicate coding-agent prompt. Keep approval policy and safety controls intact.

## Select a role at session creation

Use the existing `instructionFile` creation option with an absolute path to one of these templates: [worker](agent-profiles/worker.md), [reviewer](agent-profiles/reviewer.md), or [coordinator](agent-profiles/coordinator.md). The host snapshots the complete file and hash once at creation for supported Claude Agent and Codex sessions. Later file edits affect new sessions only. Do not infer a role from a title or mutate an ongoing session's instruction prefix.

These are opt-in file templates, not automatic role routing or a new role selector. They keep communication brief and procedures behind the repository's existing skill triggers.

Leave `skipDefaultInstructions` false or omitted to preserve native repository instructions. These templates add task boundaries; they do not replace repository procedures, change tool permissions, promote `agentRole`, or authorize delegation. A read-only profile is not a sandbox: configure execution access separately. User decisions and caller-assigned reporting/naming policies still apply.

### Workspace PR reviewer

Define `.nimbalyst/pr-review.json` in the parent workspace. Then call `spawn_session` on the host server with `{"prReview":"Diff: <base>..<head>. Brief: <scope and checks>"}`. The review runs in the caller's checkout and reports its final result.

```json
{
  "model": "openai-codex:gpt-6.2-sol",
  "effortLevel": "medium",
  "instructionFile": ".claude/agents/pr-reviewer.md",
  "permissions": "read-only",
  "generateSummary": false,
  "autoArchiveAfterMinutes": 10,
  "startupSkills": ["pr-review (tools/pr-review/SKILL.md)"]
}
```

`read-only` selects the native read-only sandbox and denies escalation. `workspace` uses the project's permission policy. The preset supplies startup skill references and leaves the native catalog available for discovery. The selected Markdown file is snapshotted when Nimbalyst creates the session.

New isolated Codex sessions remember their configured source home and launch from its private `nimbalyst-isolated` subdirectory. The home shares account files, hooks, configuration, skills and rollout directories. Global instruction files are excluded and Codex receives `project_doc_max_bytes=0`. Existing threads continue using their original home. A workspace can set `{"nativeMultiAgent":false}` in `.nimbalyst/codex.json`. Aifredas installs this default through AI-Setup. Linked worktrees inherit it from the main checkout, independently of the selected profile. Pass `nativeMultiAgent: true` on an explicit workflow spawn to enable native delegation.

Codex identifies user hooks by absolute filename. For linked hook files, Nimbalyst passes the user's saved trust hashes and enabled flags to the isolated process. Codex checks each current command against its saved hash. Changing a command requires fresh approval.

## Ownership and deferred loading

| Owner | Appropriate startup content | Load or maintain elsewhere |
| --- | --- | --- |
| Codex/Claude runtime | Provider behavior, tool invocation contracts, enforced permissions | Provider-owned tool wrappers require supported upstream configuration; Nimbalyst does not rewrite them |
| Nimbalyst | Interactive question lifecycle, file references, applicable metadata and delivery integration | Detailed tool schemas through deferred discovery; role profiles through `instructionFile` |
| Repository | Safety boundaries, delivery authorization, protected branches, skill triggers | Delivery, CI, UI, domain and coordination procedures inside existing skills |
| Session | Current objective, role, authorization, output recipient and completion criterion | Full evidence in transcript/files; concise active checkpoints at milestones |

The captured `functions.exec` wrapper includes optional tool documentation owned by the runtime/plugin integrations. The Nimbalyst MCP tool budget describes Nimbalyst tools only; it cannot remove that wrapper's documentation. At capture time, the context-mode server's global Codex configuration forced its nine tool descriptions into startup. The installed Codex 0.167.0 exposes omission controls at server level; its MCP per-tool settings do not expose individual preload controls. Claude's server-supplied `anthropic/alwaysLoad` metadata is provider-specific and is not a Codex preload preference.

Fresh native checks with the installed default model (`gpt-5.6-sol`) verified the exact setting `omit_tools_from = ["direct"]`: in a controlled session override, the nine context-mode descriptions were absent from startup and an actual `ctx_execute` MCP call completed successfully. The recorded `functions.exec` description was 13,298 UTF-8 bytes, compared with 20,236 in the original-loading probe. These are observed tool-description bytes, not measured token or latency savings. The user approved this global on-demand preference; it was reapplied with a verified private backup and unchanged approval settings after another session's `context-mode setup` had reset the first attempt. Future setup/upgrade operations may reset it again; check the effective config after those operations.

Do not also omit `code_mode`: that separate probe removed documentation but made the requested tools unavailable in this model/configuration. No `ctx_execute` call succeeded, even though the model printed the requested output marker through another tool. Marker text did not count as success. The first global test was also confounded by the concurrent installer reset, so the final verification used a full server override on one thread. Individual MCP tool pinning is not supported by the installed configuration schema; loading preferences apply to a whole server. Other models and broader task behavior remain unmeasured.

The MCP server editor now offers **Load tool details (Codex)** for servers enabled for Codex: **When needed (default)** removes `omit_tools_from`; **At startup** writes `["deferred"]` to the same user/workspace configuration. Existing hand-edited values are preserved until the loading preference is changed. The core `nimbalyst` server retains native defaults and has no ineffective editor control. Global-only servers in `~/.codex/config.toml` are outside this editor.

This is a preference for new threads. Models without tool search may expose tools directly by default, while Codex's strict third-party-tools feature can keep tools deferred even when startup loading is requested. The guard accepts either `direct` or `deferred`, rejects both together and rejects `code_mode` omissions. Source tests verify editor persistence and provider forwarding; a rebuilt-app/native-thread check of UI-written values remains outstanding. No paired token, latency or role-behavior savings have been measured.

Change optional schemas through their owning integration and measure a fresh native capture before claiming a reduction. Do not hide required tool parameters or remove recovery/approval controls to reduce bytes.

Metadata writes are idempotent for unchanged tags and phases. Explicit name assignments still reach the host, even when matching a provisional title, so the host can mark the session named. This avoids redundant tag/phase persistence and broadcasts; it does not avoid the originating tool call or its approval review. Semantic work summaries still need current evidence. Git state across shared worktrees does not by itself establish which changes belong to one session, so automatic commit tags require attribution-aware validation.

## Verify behavior before compression

Use representative read-only investigation, implementation, unresolved domain decision, UI, review-feedback and resumed-session tasks. Keep the task and model configuration fixed when comparing revisions. Record instruction compliance, unnecessary questions, tool calls, correct recipient/naming, preservation of unresolved requests and completion evidence. Observe actual provider usage and approval-review conversations separately when available. Prepared UTF-8 byte counts, recorded startup text bytes, current context tokens and cumulative billed usage are different quantities.

Do not infer a quality or latency improvement from a smaller file. Keep stable section ordering and frozen per-session inputs; changing a live prefix can affect cache reuse. Preserve hooks, data safety and release gates.

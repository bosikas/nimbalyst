import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { ClaudeContextInspection, ClaudeContextReport } from '../../../main/mcp/claudeContextInspection';
import { StartupSelectionDetails, type StartupInstructionSelection, type StartupSelection } from './StartupSelectionDetails';
import { sessionPromptAdditionsAtom } from '../../store/atoms/sessions';

type Inspection = { claude?: ClaudeContextInspection; selection?: StartupSelection; instructionSelection?: StartupInstructionSelection | null; localText?: boolean };

const muted = 'text-[var(--nim-text-muted)]';
const fmt = (tokens: number) => tokens.toLocaleString();
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : 'unknown time';

function PromptText({ title, text }: { title: string; text: string }) {
  return <details className="context-prompt-text mt-2">
    <summary className="cursor-pointer font-medium">{title}</summary>
    <pre className="mt-2 select-text whitespace-pre-wrap break-words rounded bg-[var(--nim-bg-secondary)] p-3">{text}</pre>
  </details>;
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!shown.length) return null;
  return <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
    {shown.map(([label, value]) => <React.Fragment key={label}>
      <dt className={muted}>{label}</dt>
      <dd className="select-text break-words">{value}</dd>
    </React.Fragment>)}
  </dl>;
}

/** A collapsible list; the summary carries the count and token total so it reads without expanding. */
function Group<T>({ title, items, render, tokens }: { title: string; items: T[]; render: (item: T) => React.ReactNode; tokens?: (item: T) => number }) {
  if (!items.length) return null;
  const total = tokens ? items.reduce((sum, item) => sum + tokens(item), 0) : null;
  return <details className="mt-2">
    <summary className="cursor-pointer">{title} · {items.length}{total !== null ? ` · ${fmt(total)} tokens` : ''}</summary>
    <ul className="mt-1 select-text space-y-0.5 pl-4">
      {items.map((item, index) => <li key={index} className="break-words">{render(item)}</li>)}
    </ul>
  </details>;
}

const loadState = (isLoaded: boolean | null) => isLoaded === false ? ' · deferred' : isLoaded ? ' · loaded' : '';

function ContextReport({ report }: { report: ClaudeContextReport }) {
  const breakdown = report.messageBreakdown;
  return <section>
    <h3 className="font-semibold">Context breakdown</h3>
    <p className={muted}>
      {report.source === 'live' ? 'Live from the running Claude process' : `Recorded · ${when(report.recordedAt)}`}
      {report.model ? ` · ${report.model}` : ''}
    </p>
    {report.totalTokens !== null && report.maxTokens !== null && <p className="mt-1">
      {fmt(report.totalTokens)} / {fmt(report.maxTokens)} tokens
      {report.autoCompactThreshold !== null ? ` · auto-compact at ${fmt(report.autoCompactThreshold)}` : ''}
    </p>}
    <ul className="mt-2 space-y-0.5">
      {report.categories.filter(c => c.tokens > 0).map((c, i) => <li key={i}>{c.name} · {fmt(c.tokens)} tokens</li>)}
    </ul>
    {report.apiUsage && <Facts rows={[
      ['Input', fmt(report.apiUsage.inputTokens)],
      ['Cache read', fmt(report.apiUsage.cacheReadInputTokens)],
      ['Cache write', fmt(report.apiUsage.cacheCreationInputTokens)],
      ['Output', fmt(report.apiUsage.outputTokens)],
    ]} />}
    <Group title="Memory files" items={report.memoryFiles} tokens={f => f.tokens}
      render={f => <><code>{f.path}</code> · {f.type ? `${f.type} · ` : ''}{fmt(f.tokens)} tokens</>} />
    <Group title="System prompt sections" items={report.systemPromptSections} tokens={s => s.tokens}
      render={s => <>{s.name} · {fmt(s.tokens)} tokens</>} />
    <Group title="Built-in tools" items={report.systemTools} tokens={t => t.tokens}
      render={t => <>{t.name} · {fmt(t.tokens)} tokens</>} />
    <Group title="Deferred built-in tools" items={report.deferredBuiltinTools} tokens={t => t.tokens}
      render={t => <>{t.name} · {fmt(t.tokens)} tokens{loadState(t.isLoaded)}</>} />
    <Group title="MCP tools" items={report.mcpTools} tokens={t => t.tokens}
      render={t => <>{t.name}{t.serverName ? ` (${t.serverName})` : ''} · {fmt(t.tokens)} tokens{loadState(t.isLoaded)}</>} />
    <Group title="MCP server instructions" items={report.mcpInstructions} tokens={i => i.tokens}
      render={i => <>{i.serverName} · {fmt(i.tokens)} tokens</>} />
    <Group title="Agents" items={report.agents} tokens={a => a.tokens}
      render={a => <>{a.agentType}{a.source ? ` · ${a.source}` : ''} · {fmt(a.tokens)} tokens</>} />
    <Group title="Skills" items={report.skills} tokens={s => s.tokens}
      render={s => <>{s.name}{s.source ? ` · ${s.source}` : ''} · {fmt(s.tokens)} tokens</>} />
    {breakdown && <Group title="Messages" items={Object.entries(breakdown).filter(([, v]) => v > 0)} tokens={([, v]) => v}
      render={([key, value]) => <>{key.replace(/Tokens$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()} · {fmt(value)} tokens</>} />}
  </section>;
}

export function ClaudeContextInspectionDetails({ sessionId }: { sessionId: string }) {
  const additions = useAtomValue(sessionPromptAdditionsAtom(sessionId));
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.electronAPI.invoke('mcp-config:get-context-inspection', sessionId)
      .then((value: Inspection) => { if (!cancelled) setInspection(value); })
      .catch(() => { if (!cancelled) setError('Could not load Claude context details.'); });
    return () => { cancelled = true; };
  }, [sessionId, revision]);

  const claude = inspection?.claude;
  const request = claude?.lastRequest;
  const startup = claude?.startup;
  const cli = claude?.cli;
  return <div className="claude-context-inspection space-y-4">
    <div>
      <button type="button" onClick={() => setRevision(value => value + 1)} className="text-[var(--nim-link)] hover:underline">Refresh</button>
      {error && <p role="status">{error}</p>}
      {!inspection && !error && <p role="status">Loading context details…</p>}
    </div>
    <StartupSelectionDetails selection={inspection?.selection} instructions={inspection?.instructionSelection} />
    {claude && <p>Latest response model: {claude.responseModel ?? 'Unavailable'}.</p>}
    {claude && !cli && inspection?.localText && additions && <section>
      <h3 className="font-semibold">Live Nimbalyst prompt additions</h3>
      <p className={muted}>{new Date(additions.timestamp).toLocaleString()}</p>
      {additions.systemPromptAddition && additions.systemPromptAddition !== request?.systemPromptAppend &&
        <PromptText title="Prepared system prompt addition" text={additions.systemPromptAddition} />}
      {additions.userMessageAddition && <PromptText title="Prepared user message addition" text={additions.userMessageAddition} />}
    </section>}
    {claude && (claude.contextReport
      ? <ContextReport report={claude.contextReport} />
      : <section><h3 className="font-semibold">Context breakdown</h3><p className={muted}>Recorded after each completed turn. This session has not finished a turn since the breakdown was added.</p></section>)}
    {request && <section>
      <h3 className="font-semibold">Last prepared SDK request</h3>
      <p className={muted}>{when(request.recordedAt)}</p>
      <Facts rows={[
        ['Requested model', request.model],
        ['Requested effort', request.effort],
        ['Permission mode', request.permissionMode],
        ['Thinking', request.thinking ? JSON.stringify(request.thinking) : null],
        ['System prompt', request.systemPromptPreset ? `Claude Code preset (${request.systemPromptPreset}) + Nimbalyst append` : null],
        ['Setting sources', request.settingSources.join(', ')],
        ['MCP servers', request.mcpServers.join(', ')],
        ['Allowed tools', request.allowedTools.join(', ')],
        ['Disallowed tools', request.disallowedTools.join(', ')],
        ['Attachments', request.attachments.join(', ')],
      ]} />
      {request.resumed && <p className={muted}>The SDK manages earlier history on resume. This app guidance was prepared for the current turn.</p>}
      {request.systemPromptAppend && <PromptText title="Prepared Nimbalyst system prompt append" text={request.systemPromptAppend} />}
      {request.customSystemPrompt && <PromptText title="Prepared custom system prompt" text={request.customSystemPrompt} />}
      {request.prompt && <PromptText title="Prepared user input with Nimbalyst additions" text={request.prompt} />}
    </section>}
    {claude && !cli && <p className={muted}>{!request && 'No prepared SDK request was retained. '}Native Claude system and skill text and provider-accepted effort are unavailable through the SDK.</p>}
    {cli && <>
      <section>
        <h3 className="font-semibold">Prepared Claude CLI launch</h3>
        {cli.launch ? <>
          <p className={muted}>{when(cli.launch.recordedAt)} · {cli.launch.resumed ? 'Resume' : 'Fresh launch'}</p>
          <Facts rows={[
            ['Requested model', cli.launch.model],
            ['Requested effort', cli.launch.effort],
            ['App MCP', cli.launch.enterpriseMcpLockdown ? 'Enterprise policy excluded app MCP tools' : 'Normal launch policy'],
          ]} />
          {cli.launch.append && <PromptText title="Prepared system prompt append" text={cli.launch.append} />}
        </> : <p className={muted}>No prepared CLI launch retained in this app process.</p>}
      </section>
      <section>
        <h3 className="font-semibold">Observed Claude CLI request</h3>
        {cli.request ? <>
          <p className={muted}>First parent Messages API request captured by the proxy for an observed launch · {when(cli.request.recordedAt)}</p>
          {cli.launch && cli.request.recordedAt < cli.launch.recordedAt && <p className={muted}>This capture is from an earlier CLI launch.</p>}
          <Facts rows={[[ 'Observed request model', cli.request.model ], [ 'Observed request effort', cli.request.effort ]]} />
          {cli.request.blocks.map((block, index) => {
            const title = `${block.role} text · ${fmt(block.bytes)} bytes${block.truncated ? ' · preview truncated' : ''}`;
            return block.text ? <PromptText key={index} title={title} text={block.text} /> : <p key={index}>{title}</p>;
          })}
          <p className={muted}>Local previews retain a bounded sample of system and user text. Native project instructions, reminders and skill definitions appear when captured in those blocks. Provider-accepted effort is unavailable.</p>
          {cli.request.blocks.length > 0 && cli.request.blocks.every(block => block.text === undefined) && <p className={muted}>Text previews are available in the local desktop inspector during the app process that captured them.</p>}
        </> : <p className={muted}>No proxy request was retained. Terminal-only sessions and older launches may have no request capture.</p>}
      </section>
    </>}
    {startup && <section>
      <h3 className="font-semibold">Session startup</h3>
      <p className={muted}>{when(startup.recordedAt)}</p>
      <Facts rows={[
        ['Startup model', startup.model],
        ['Claude Code', startup.claudeCodeVersion],
        ['Permission mode', startup.permissionMode],
        ['Output style', startup.outputStyle],
        ['API key source', startup.apiKeySource],
        ['Working directory', startup.cwd],
      ]} />
      <Group title="Tools" items={startup.tools} render={name => name} />
      <Group title="MCP servers" items={startup.mcpServers} render={s => <>{s.name}{s.status ? ` · ${s.status}` : ''}</>} />
      <Group title="Agents" items={startup.agents} render={name => name} />
      <Group title="Plugins" items={startup.plugins} render={p => <>{p.name}{p.path ? <> · <code>{p.path}</code></> : null}</>} />
      <Group title="Skills" items={startup.skills} render={name => name} />
      <Group title="Slash commands" items={startup.slashCommands} render={name => `/${name}`} />
    </section>}
  </div>;
}

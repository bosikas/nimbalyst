import type { WorkflowEvidence } from '../../../main/mcp/workflowEvidence';

export type { WorkflowEvidence };

export function WorkflowEvidenceDetails({ evidence }: { evidence: WorkflowEvidence }) {
  return <details className="mt-2">
    <summary className="cursor-pointer font-semibold">Instruction sources, skills and hooks</summary>
    <div className="mt-2 space-y-3">
      <section>
        <h3 className="font-medium">Instruction sources</h3>
        <p>Installed Nimbalyst addendum version {evidence.addendumVersion}
          {evidence.skipApp ? ' · default guidance disabled for this session' : ''}</p>
        <ul>{evidence.layers.map(layer => <li key={layer.layer}>
          {layer.layer} · {layer.file} · {layer.layer === 'Session snapshot' ? 'Saved at session creation'
            : layer.found ? 'Found on disk' : 'Unavailable'}
        </li>)}</ul>
        {evidence.duplicates > 0 && <p>
          Repeated sections across instruction files: {evidence.duplicates}
        </p>}
        {evidence.skipProject && <p>Codex repository instruction discovery is disabled for this session.</p>}
        <p className="text-[var(--nim-text-muted)]">
          The app adds session-specific guidance after its defaults. A provider resolves its own
          project and worktree files. New sessions pick up current sources. Saved session
          instruction snapshots stay fixed on resume. A native thread can retain earlier
          context. Check the prepared and recorded sections for evidence of what was sent.
        </p>
      </section>
      <section>
        <h3 className="font-medium">Skill reads</h3>
        {evidence.skillReceipts.length === 0 && <p>No complete managed skill reads recorded.</p>}
        <ul>{evidence.skillReceipts.map((receipt, index) => <li key={index}>
          {receipt.name} · {receipt.reason} · {receipt.worktree} · {new Date(receipt.timestamp).toLocaleString()}
        </li>)}</ul>
      </section>
      <section>
        <h3 className="font-medium">Hook receipts</h3>
        {evidence.hookStatus !== 'observed' && <p>{evidence.hookStatus === 'unavailable'
          ? 'Hook receipts are unavailable for this provider.'
          : 'No hook receipts found for this session.'}</p>}
        <ul>{evidence.hookReceipts.map((receipt, index) => <li key={index}>
          {receipt.name} · {receipt.result} · {receipt.reason} · {receipt.worktree}
          {' · '}{new Date(receipt.timestamp).toLocaleString()}
        </li>)}</ul>
      </section>
    </div>
  </details>;
}

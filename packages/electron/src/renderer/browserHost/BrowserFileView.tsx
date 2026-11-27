import React, { useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

type Request = (path: string, init?: RequestInit) => Promise<Response>;

type FileState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'text'; content: string }
  | { status: 'binary'; blob: Blob; type: string };

function isTextType(type: string): boolean {
  return type.startsWith('text/') || type.includes('json') || type.includes('javascript') ||
    type.includes('xml') || type.includes('yaml');
}

/**
 * Browser-host viewer for a workspace file opened from a transcript link. The
 * bytes arrive through the bearer-token `/api/file` route, so no new tab (and
 * no token in the URL) is needed.
 */
export default function BrowserFileView({ request, path }: { request: Request; path: string }) {
  const [state, setState] = useState<FileState>({ status: 'loading' });
  const fileName = path.split('/').filter(Boolean).pop() ?? path;

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void request('/file?path=' + encodeURIComponent(path)).then(async (response) => {
      if (!active) return;
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setState({ status: 'error', message: data?.error ?? 'File could not be loaded' });
        return;
      }
      const type = response.headers.get('content-type') ?? '';
      if (isTextType(type)) {
        setState({ status: 'text', content: await response.text() });
      } else {
        setState({ status: 'binary', blob: await response.blob(), type });
      }
    }).catch((error: Error) => {
      if (active) setState({ status: 'error', message: error.message });
    });
    return () => { active = false; };
  }, [request, path]);

  const objectUrl = useMemo(
    () => state.status === 'binary' ? URL.createObjectURL(state.blob) : null,
    [state],
  );
  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  return (
    <section className="browser-host-file" aria-label={path}>
      <header className="browser-host-file-header">
        <MaterialSymbol icon="draft" size={18} />
        <div className="browser-host-file-title">
          <h2>{fileName}</h2>
          <p title={path}>{path}</p>
        </div>
      </header>
      {state.status === 'loading' && <p role="status">Loading file…</p>}
      {state.status === 'error' && <p role="alert" className="browser-host-history-error">{state.message}</p>}
      {state.status === 'text' && <pre className="browser-host-file-content"><code>{state.content}</code></pre>}
      {state.status === 'binary' && objectUrl && (
        state.type.startsWith('image/')
          ? <img className="browser-host-file-image" src={objectUrl} alt={fileName} />
          : (
            <div className="browser-host-file-binary">
              <p>This file type cannot be previewed in the browser.</p>
              <a href={objectUrl} download={fileName}>Download {fileName}</a>
            </div>
          )
      )}
    </section>
  );
}

import React, { useEffect, useRef, useState } from 'react';

const maxTextPreviewBytes = 2 * 1024 * 1024;
const rasterTypes = new Map([
  ['avif', 'image/avif'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);
const textExtensions = new Set([
  'cjs', 'css', 'csv', 'html', 'js', 'json', 'log', 'markdown', 'md', 'mjs', 'py',
  'sh', 'sql', 'svg', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);
type FileState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; url: string; image: boolean; text?: string };

export default function BrowserFileView({ request, path, onClose }: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  path: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<FileState>({ status: 'loading' });
  const name = path.split(/[\\/]/).pop() || 'File';

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let objectUrl: string | undefined;
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    const imageType = rasterTypes.get(extension);

    async function load() {
      try {
        const response = await request('/file-link?' + new URLSearchParams({ path }), { signal });
        const bytes = await response.arrayBuffer();
        if (signal.aborted) return;
        const text = bytes.byteLength <= maxTextPreviewBytes && textExtensions.has(extension)
          ? new TextDecoder().decode(bytes)
          : undefined;
        // Keep active document formats as plain text previews and inert downloads.
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: imageType ?? 'application/octet-stream' }));
        setFile({ status: 'ready', url: objectUrl, image: Boolean(imageType), text });
      } catch (error) {
        if (!signal.aborted) {
          setFile({ status: 'error', message: error instanceof Error ? error.message : 'File unavailable' });
        }
      }
    }

    setFile({ status: 'loading' });
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [name, path, request]);

  return (
    <dialog ref={dialog} onClose={onClose} aria-label={name} className="browser-host-file-dialog">
      <header>
        <h2 title={path}>{name}</h2>
        {file.status === 'ready' && <a href={file.url} download={name}>Download</a>}
        <button type="button" onClick={() => dialog.current?.close()}>Close</button>
      </header>
      <div className="browser-host-file-preview">
        {file.status === 'loading' && <p role="status">Loading file…</p>}
        {file.status === 'error' && <p role="alert">{file.message}</p>}
        {file.status === 'ready' && file.image && <img src={file.url} alt={name} />}
        {file.status === 'ready' && file.text !== undefined && <pre>{file.text}</pre>}
        {file.status === 'ready' && !file.image && file.text === undefined && <p>Download this file to open it.</p>}
      </div>
    </dialog>
  );
}

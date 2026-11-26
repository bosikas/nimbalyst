import React, { lazy, Suspense, useMemo } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import * as virtua from 'virtua';
import { createReadOnlyEditorHost } from '../components/HistoryDialog/createReadOnlyEditorHost';
import '../../../../extensions/pdf-viewer/src/styles/textLayer.css';

const PDFViewer = lazy(async () => {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
  Object.defineProperty(window, '__nimbalyst_extensions', {
    value: { 'pdfjs-dist': pdfjs, virtua },
  });
  const { PDFViewerEditor } = await import('../../../../extensions/pdf-viewer/src/PDFViewerEditor');
  return { default: PDFViewerEditor };
});

export default function BrowserPdf({ fileName, loadPdf }: { fileName: string; loadPdf: () => Promise<ArrayBuffer> }) {
  const host = useMemo(() => {
    const baseline = createReadOnlyEditorHost({ filePath: fileName, fileName, theme: 'light', content: '' });
    let bytes: Promise<ArrayBuffer> | undefined;
    return {
      ...baseline,
      async loadBinaryContent() {
        bytes ??= loadPdf();
        return (await bytes).slice(0);
      },
    };
  }, [fileName, loadPdf]);

  return (
    <div className="browser-host-pdf">
      <Suspense fallback={<p role="status">Loading PDF Viewer…</p>}>
        <PDFViewer host={host} />
      </Suspense>
    </div>
  );
}

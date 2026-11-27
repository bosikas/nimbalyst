import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserFileView from '../BrowserFileView';

const createObjectURL = vi.fn(() => 'blob:preview');
const revokeObjectURL = vi.fn();
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
});

afterEach(() => {
  cleanup();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.unstubAllGlobals();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

describe('BrowserFileView', () => {
  it('shows HTML as text and offers the original file for download', async () => {
    const path = '/shared/AWM mock.html';
    const source = '<h1>AWM mock</h1><script>run()</script>';
    const request = vi.fn(async () => new Response(source, {
      headers: { 'Content-Type': 'application/octet-stream' },
    }));

    render(<BrowserFileView request={request} path={path} onClose={vi.fn()} />);

    expect(await screen.findByText(source)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'AWM mock' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('AWM mock.html');
    expect(request).toHaveBeenCalledWith('/file-link?path=%2Fshared%2FAWM+mock.html', {
      signal: expect.any(AbortSignal),
    });
  });

  it('previews a raster image and releases its object URL when closed', async () => {
    const request = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71])));
    const { unmount } = render(
      <BrowserFileView request={request} path="/shared/mock.PNG" onClose={vi.fn()} />,
    );

    expect((await screen.findByRole('img', { name: 'mock.PNG' })).getAttribute('src')).toBe('blob:preview');
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('shows an access denial without making a download available', async () => {
    const request = vi.fn().mockRejectedValue(new Error('This file has not been shared with this browser workspace'));
    render(<BrowserFileView request={request} path="/private/file.txt" onClose={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('has not been shared');
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserFileView from '../BrowserFileView';

afterEach(() => {
  vi.restoreAllMocks();
});

it('loads and renders a text file through the token-authed request', async () => {
  const request = vi.fn(async (path: string) => {
    expect(path).toBe('/file?path=' + encodeURIComponent('/workspace/notes.md'));
    return new Response('# Hello', { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  });
  render(<BrowserFileView request={request} path="/workspace/notes.md" />);
  expect(await screen.findByText('# Hello')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'notes.md' }).textContent).toBe('notes.md');
  expect(request).toHaveBeenCalledTimes(1);
});

it('shows the server error when the file is unavailable', async () => {
  const request = vi.fn(async () => Response.json({ error: 'File unavailable' }, { status: 404 }));
  render(<BrowserFileView request={request} path="/workspace/missing.md" />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('File unavailable');
});

it('offers a download for binary files', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const request = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'application/octet-stream' },
  }));
  render(<BrowserFileView request={request} path="/workspace/data.bin" />);
  const link = await screen.findByRole('link', { name: 'Download data.bin' });
  expect(link.getAttribute('download')).toBe('data.bin');
  expect(link.getAttribute('href')).toBe('blob:mock');
});

it('renders images inline via a blob URL', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:img');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const request = vi.fn(async () => new Response(new Uint8Array([137, 80]), {
    headers: { 'content-type': 'image/png' },
  }));
  render(<BrowserFileView request={request} path="/workspace/pic.png" />);
  const image = await screen.findByRole('img', { name: 'pic.png' });
  expect(image.getAttribute('src')).toBe('blob:img');
});

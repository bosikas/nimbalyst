export async function downloadBrowserFile(
  request: (path: string) => Promise<Response>,
  path: string,
): Promise<void> {
  const response = await request('/file-link?' + new URLSearchParams({ path }));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = path.split(/[\\/]/).pop() || 'file';
  try {
    link.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

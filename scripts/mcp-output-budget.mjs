import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const MAX_RESULT_BYTES = 8192;
export const MAX_RESULT_LINES = 20;

/** Enforce delivery size after execution, including JSON escaping and the recovery notice. */
export async function boundMcpResult(result) {
  const serialized = JSON.stringify(result);
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES && text.split('\n').length <= MAX_RESULT_LINES) return result;
  const directory = await mkdtemp(join(tmpdir(), 'nimbalyst-mcp-output-'));
  const file = join(directory, 'full-output.json');
  await writeFile(file, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  const notice = 'Preview only. Full output saved to: ' + file +
    '\nUse ctx_execute(file=...) to inspect the saved JSON and print only the answer.\n\n';
  const body = Array.from(text.split('\n').slice(0, MAX_RESULT_LINES - notice.split('\n').length + 1).join('\n'));
  const response = length => ({
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    content: [{ type: 'text', text: notice + body.slice(0, length).join('') }],
  });
  let low = 0, high = body.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(response(mid))) <= MAX_RESULT_BYTES) low = mid;
    else high = mid - 1;
  }
  return response(low);
}

/** JSON-RPC stdio proxy. Discovery and non-tool responses are unchanged. */
export async function proxyMcp(command, args, { input = process.stdin, output = process.stdout } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const clientLines = createInterface({ input, crlfDelay: Infinity });
  const serverLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdin.on('error', () => clientLines.close());
  const closed = new Promise((resolve, reject) => {
    child.once('error', error => { clientLines.close(); reject(error); });
    child.once('close', (code, signal) => { clientLines.close(); resolve(code ?? (signal ? 1 : 0)); });
  });
  const pending = new Set();
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const write = async (stream, line) => {
    if (!stream.write(line + '\n')) await once(stream, 'drain');
  };
  try {
    const results = await Promise.all([
      (async () => {
        for await (const line of clientLines) {
          const message = JSON.parse(line);
          if (message.method === 'tools/call' && message.id !== undefined) pending.add(JSON.stringify(message.id));
          await write(child.stdin, line);
        }
        child.stdin.end();
      })(),
      (async () => {
        for await (const line of serverLines) {
          const message = JSON.parse(line);
          if (message.method === undefined && message.id !== undefined && pending.delete(JSON.stringify(message.id))) {
            if (message.result) {
              message.result = await boundMcpResult(message.result);
            } else if (message.error) {
              const envelope = {
                isError: true,
                content: [{ type: 'text', text: message.error.message ?? 'MCP tool failed' }],
                structuredContent: { error: message.error },
              };
              const bounded = await boundMcpResult(envelope);
              if (bounded !== envelope) {
                message.error = { code: message.error.code, message: bounded.content[0].text };
              }
            }
            await write(output, JSON.stringify(message));
          } else {
            await write(output, line);
          }
        }
      })(),
      closed,
    ]);
    return results[2];
  } finally {
    clientLines.close();
    serverLines.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (child.exitCode === null) stop();
  }
}

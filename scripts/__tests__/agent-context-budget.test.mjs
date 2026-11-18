import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const script = fileURLToPath(new URL('../agent-context-budget.py', import.meta.url));
const cwd = mkdtempSync(path.join(tmpdir(), 'agent-context-budget-'));
after(() => rmSync(cwd, { recursive: true, force: true }));
writeFileSync(path.join(cwd, 'small.txt'), 'small\n');
writeFileSync(path.join(cwd, 'large.txt'), 'x\n'.repeat(1000));
writeFileSync(path.join(cwd, 'wide.txt'), 'x'.repeat(20000));
writeFileSync(path.join(cwd, 'CLAUDE.md'), 'instructions\n'.repeat(100));

function decision(command, extra = {}) {
  const result = spawnSync('python3', [script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command }, ...extra }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
}
function denied(command) {
  assert.equal(decision(command)?.permissionDecision, 'deny', command);
}
function allowed(command) {
  assert.equal(decision(command), undefined, command);
}

test('blocks large reads, batches, and wide lines before execution', () => {
  denied('cat large.txt');
  denied('cat wide.txt');
  denied('cat large.txt 2>/dev/null');
  denied("sed -n '1,100p' large.txt");
  denied("sed -n '1,15p' large.txt; sed -n '16,30p' large.txt");
  denied('cat small.txt '.repeat(21));
});
test('a bound on a later command cannot exempt an earlier dump', () => {
  denied('cat large.txt; echo ok | head -n 1');
  denied("sed -n '1,500p' large.txt; echo ok | head -n 1");
  denied("rg --files; echo ok | head -n 1");
  denied("rg --files | head -n 20; rg --files | head -n 20");
  denied('echo ok | cat large.txt');
  denied('cat small.txt | cat large.txt');
  denied('cat large.txt | head -n 1 | cat large.txt');
  denied('sh -c "cat large.txt; echo ok | head -n 1"');
});
test('allows small files, focused ranges, and bounded searches', () => {
  allowed('cat small.txt');
  allowed("sed -n '1,20p' large.txt");
  allowed('cat large.txt | head -n 10');
  allowed('rg -n symbol . | head -n 10');
  allowed('rg --files | head -n 20');
  allowed('git status --short');
  denied('rg -n symbol .');
  denied('git diff');
});
test('instruction reads are exempt only for their own pipeline', () => {
  allowed('cat CLAUDE.md');
  denied('cat CLAUDE.md; cat large.txt');
  denied('cat CLAUDE.md large.txt');
});
test('does not execute commands, modify files, or interfere with redirected writes', () => {
  allowed('cat small.txt > copy.txt');
  denied('cat large.txt; touch should-not-exist');
  denied('cat large.txt 2>/dev/null');
  denied('git diff --stat');
  allowed('git diff --stat | head -n 20');
  allowed('git log --oneline -5');
  assert.equal(existsSync(path.join(cwd, 'copy.txt')), false);
  assert.equal(existsSync(path.join(cwd, 'should-not-exist')), false);
});
test('bounds Read by bytes and lines, including explicit oversized limits', () => {
  const read = (file_path, limit) => decision('', { tool_name: 'Read', tool_input: { file_path, limit } });
  assert.equal(read('large.txt')?.permissionDecision, 'deny');
  assert.equal(read('large.txt', 21)?.permissionDecision, 'deny');
  assert.equal(read('wide.txt', 1)?.permissionDecision, 'deny');
  assert.equal(read('large.txt', 20), undefined);
  assert.equal(read('small.txt'), undefined);
});

test('both provider configurations execute the guard and preserve the Claude commit gate', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    const hook = config.hooks.PreToolUse.flatMap(group => group.hooks)
      .find(entry => entry.command.includes('agent-context-budget.py'));
    assert.ok(hook, file);
    const result = spawnSync(hook.command, {
      shell: true, cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8',
      input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command: 'cat large.txt' } }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', file);
    if (file.startsWith('.claude')) {
      // The raw plugin server is disabled; its hooks and the bounded local
      // server are configured separately so it cannot bypass response limits.
      assert.equal(config.enabledPlugins['context-mode@context-mode'], false);
      assert.ok(config.hooks.PostToolUse.some(group => group.hooks.some(entry => entry.command.includes('context-mode-server.mjs'))));
      const mcp = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
      assert.ok(mcp.mcpServers['context-mode'].args.some(arg => arg.includes('context-mode-server.mjs')));
      assert.ok(config.hooks.PreToolUse.some(group => group.hooks.some(entry => entry.command.includes('agent-test-gate.mjs'))));
    }
  }
});

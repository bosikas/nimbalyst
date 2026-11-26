type Token = { text: string; start: number; end: number };
const relations = new Set([
  'ai_sessions', 'ai_agent_messages', 'session_commits', 'queued_prompts', 'ai_session_wakeups',
]);
const expressions = new Set([
  'select', 'values', 'from', 'join', 'in', 'exists', 'not', 'where', 'having',
  'on', 'and', 'or', 'when', 'then', 'else', 'by', 'over', 'filter',
  'abs', 'avg', 'cast', 'coalesce', 'count', 'ifnull', 'instr', 'json_extract', 'json_valid',
  'length', 'lower', 'max', 'min', 'nullif', 'replace', 'round', 'row_number',
  'substr', 'substring', 'sum', 'trim', 'upper',
]);
const endOfFrom = new Set(['where', 'having', 'limit', 'union', 'except', 'intersect']);
const identifier = /^[a-z_][a-z0-9_]*$/;

function rejectQuery(): never {
  throw new Error('Unsupported browser extension query');
}

function tokenize(sql: string): Token[] {
  // Keep string literals opaque. Unsupported quoting and statement separators
  // fail closed so they cannot change the meaning of a relation token.
  const lex = /\s+|--[^\r\n]*|\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\/|'(?:[^'\\]|'')*'|[a-z_][a-z0-9_]*|\$[1-9]\d*|\d+(?:\.\d+)?|[().,=*<>!%+\-/|]/igy;
  const tokens: Token[] = [];
  for (let cursor = 0; cursor < sql.length;) {
    lex.lastIndex = cursor;
    const match = lex.exec(sql);
    if (!match) rejectQuery();
    const text = match[0];
    if (text.startsWith('/*') && text.slice(2).includes('/*')) rejectQuery();
    if (!/^\s|^--|^\/\*/.test(text)) tokens.push({ text: text.toLowerCase(), start: cursor, end: lex.lastIndex });
    cursor = lex.lastIndex;
  }
  return tokens;
}

function closingParen(tokens: Token[], start: number) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++;
    if (tokens[i].text === ')' && --depth === 0) return i;
  }
  return rejectQuery();
}

function inspectSelect(tokens: Token[], ctes: Set<string>, used: Set<string>) {
  if (!['select', 'values'].includes(tokens[0]?.text)) rejectQuery();
  const from = [false];
  for (let i = 0; i < tokens.length; i++) {
    const { text } = tokens[i];
    const previous = tokens[i - 1]?.text;
    const next = tokens[i + 1]?.text;
    if (text === 'with' || text === 'into' || text === 'table') rejectQuery();
    if (text === '(') {
      from.push(false);
    } else if (text === ')') {
      from.pop();
      if (from.length === 0) rejectQuery();
    } else if (previous !== '.' && (endOfFrom.has(text) || ((text === 'group' || text === 'order') && next === 'by'))) {
      from[from.length - 1] = false;
    } else if (text === 'from' || text === 'join' || (text === ',' && from.at(-1))) {
      from[from.length - 1] = true;
      if (next === '(') {
        if (!['select', 'values'].includes(tokens[i + 2]?.text)) rejectQuery();
      } else {
        if (!next || tokens[i + 2]?.text === '.' || tokens[i + 2]?.text === '(') rejectQuery();
        if (relations.has(next)) used.add(next);
        else if (!ctes.has(next)) rejectQuery();
      }
    } else if (next === '(' && identifier.test(text) && (previous === '.' || !expressions.has(text))) {
      rejectQuery();
    }
  }
  if (from.length !== 1) rejectQuery();
}

/** Accept the read-only SELECT and CTE shapes used by extension panels. */
export function scopeBrowserExtensionQuery(sql: string, params: unknown[], workspacePath: string, engine: 'sqlite' | 'pglite') {
  const tokens = tokenize(sql);
  const used = new Set<string>();
  const ctes = new Set<string>();
  let selectStart = 0;
  if (tokens[0]?.text === 'with') {
    selectStart = 1;
    do {
      const name = tokens[selectStart++]?.text;
      if (!name || !identifier.test(name) || relations.has(name) || ctes.has(name)) rejectQuery();
      if (tokens[selectStart]?.text === '(') selectStart = closingParen(tokens, selectStart) + 1;
      if (tokens[selectStart++]?.text !== 'as' || tokens[selectStart]?.text !== '(') rejectQuery();
      const end = closingParen(tokens, selectStart);
      inspectSelect(tokens.slice(selectStart + 1, end), ctes, used);
      ctes.add(name);
      selectStart = end + 1;
    } while (tokens[selectStart]?.text === ',' && ++selectStart);
  }
  inspectSelect(tokens.slice(selectStart), ctes, used);
  for (const token of tokens) {
    if (token.text.startsWith('$') && Number(token.text.slice(1)) > params.length) rejectQuery();
  }
  if (used.size === 0) return { sql, params };

  const schema = engine === 'sqlite' ? 'main' : 'public';
  const scoped = [`ai_sessions AS (SELECT * FROM ${schema}.ai_sessions WHERE workspace_id = $${params.length + 1})`];
  for (const table of used) {
    if (table !== 'ai_sessions') {
      scoped.push(`${table} AS (SELECT * FROM ${schema}.${table} WHERE session_id IN (SELECT id FROM ai_sessions))`);
    }
  }
  const body = tokens[0].text === 'with' ? sql.slice(tokens[0].end) : sql;
  return {
    sql: `WITH ${scoped.join(', ')}${ctes.size ? ',' : ''} ${body}`,
    params: [...params, workspacePath],
  };
}

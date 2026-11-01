// Bounded, read-only client for the official MCP Registry (ADR-024 §4.4a). Built-ins only.
// Fails closed: any bound violation throws, and the run produces no PR.

export const OFFICIAL_BASE = 'https://registry.modelcontextprotocol.io';
export const ALLOWED_SCHEMAS = new Set(['https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json']);
export const LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  pageSize: 100, // the API rejects larger values (422 observed at 500)
  maxPages: 50,
  maxRows: 5000,
  maxDepth: 24,
});

/** Read a response body through a size cap; aborts (throws) beyond `max` bytes. */
export async function readCapped(res, max = LIMITS.maxBytes) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error('response too large');
  const chunks = [];
  let total = 0;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel().catch(() => {}); throw new Error('response too large'); }
      chunks.push(value);
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw new Error('response too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/** Max nesting depth of a parsed JSON value (iterative, so a hostile document cannot blow the stack). */
export function jsonDepth(value) {
  let max = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v && typeof v === 'object') {
      if (d > max) max = d;
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, d + 1]);
    }
  }
  return max;
}

/** GET a JSON document with timeout, size cap and depth cap. Returns {status, json} (404 → {status:404}). */
export async function getJson(url, { fetchImpl = fetch, timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'error' });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const text = await readCapped(res, maxBytes);
  const json = JSON.parse(text);
  if (jsonDepth(json) > LIMITS.maxDepth) throw new Error('JSON nested too deeply');
  return { status: 200, json };
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate one list page's shape. Rows that are malformed or carry an unknown $schema are skipped, not fatal. */
export function parsePage(json) {
  if (!isObj(json) || !Array.isArray(json.servers)) throw new Error('unexpected page shape');
  const cursor = isObj(json.metadata) && typeof json.metadata.nextCursor === 'string' ? json.metadata.nextCursor : '';
  if (cursor.length > 512) throw new Error('cursor too long');
  const rows = [];
  const skipped = [];
  for (const row of json.servers) {
    const s = isObj(row) ? row.server : undefined;
    if (!isObj(s) || typeof s.name !== 'string' || typeof s.version !== 'string') { skipped.push({ name: '(malformed)', reason: 'malformed-row' }); continue; }
    if (!ALLOWED_SCHEMAS.has(s.$schema)) { skipped.push({ name: s.name.slice(0, 120), reason: 'unknown-$schema' }); continue; }
    rows.push(row);
  }
  return { rows, skipped, cursor };
}

/**
 * Walk the paged list. Stops at an empty cursor. A repeated cursor, a page that adds no new rows, or
 * exceeding the page/row caps throws (non-zero exit, no PR).
 */
export async function fetchAll({ base = OFFICIAL_BASE, fetchImpl = fetch, maxPages = LIMITS.maxPages, maxRows = LIMITS.maxRows } = {}) {
  const seenCursors = new Set();
  const seenRows = new Set();
  const rows = [];
  const skipped = [];
  let cursor = '';
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`page cap (${maxPages}) reached before the feed ended`);
    const url = `${base}/v0.1/servers?limit=${LIMITS.pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { status, json } = await getJson(url, { fetchImpl });
    if (status !== 200) throw new Error('list endpoint returned 404');
    const p = parsePage(json);
    let fresh = 0;
    for (const row of p.rows) {
      const key = `${row.server.name}@${row.server.version}`;
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      rows.push(row);
      fresh++;
    }
    skipped.push(...p.skipped);
    if (rows.length > maxRows) throw new Error(`row cap (${maxRows}) exceeded`);
    if (!p.cursor) return { rows, skipped, pages: page + 1 };
    if (seenCursors.has(p.cursor)) throw new Error('cursor loop detected');
    if (fresh === 0 && p.skipped.length === 0) throw new Error('page added no new rows (cursor loop)');
    seenCursors.add(p.cursor);
    cursor = p.cursor;
  }
}

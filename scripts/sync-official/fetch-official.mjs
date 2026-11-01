// Bounded, read-only client for the official MCP Registry (ADR-024 §4.4a). Built-ins only.
// Fails closed: any bound violation throws, and the run produces no PR.

export const OFFICIAL_BASE = 'https://registry.modelcontextprotocol.io';
export const ALLOWED_SCHEMAS = new Set(['https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json']);
export const LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  pageSize: 100, // the API rejects larger values (422 observed at 500)
  // Sized from a live measurement (2026-11-01, version=latest): 545 pages / ~51k deduped rows; ~3x headroom.
  maxPages: 1650,
  maxRawRows: 165_000, // every row the feed returns, kept or dropped
  maxTotalBytes: 1024 * 1024 * 1024, // cumulative bytes read across the whole walk
  maxSkippedKept: 100, // skipped rows are counted, but only this many are listed
  budgetMs: 10 * 60_000, // whole-walk wall clock; the workflow job timeout is 15 min
  logEvery: 50,
  maxDepth: 24,
});

/** Read a response body through a size cap; aborts (throws) beyond `max` bytes. */
export async function readCapped(res, max = LIMITS.maxBytes) {
  return (await readBody(res, max)).text;
}

/** Same as readCapped, but also reports the real number of bytes read (for the cumulative cap). */
export async function readBody(res, max = LIMITS.maxBytes) {
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
    total = buf.byteLength;
  }
  return { text: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'), bytes: total };
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
  const { text, bytes } = await readBody(res, maxBytes);
  const json = JSON.parse(text);
  if (jsonDepth(json) > LIMITS.maxDepth) throw new Error('JSON nested too deeply');
  return { status: 200, json, bytes };
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
 * Walk the paged list (latest versions only). Stops at an empty cursor. A repeated cursor, a page that adds no new rows,
 * or exceeding the page / raw-row / wall-clock caps throws (non-zero exit, no PR).
 * `keep(row)` may return a reason string to drop a row immediately (network-free rules only); dropped rows are counted
 * in `dropped` but not retained, so memory holds survivors, not the whole feed.
 */
export async function fetchAll({
  base = OFFICIAL_BASE, fetchImpl = fetch, maxPages = LIMITS.maxPages, maxRawRows = LIMITS.maxRawRows,
  budgetMs = LIMITS.budgetMs, maxTotalBytes = LIMITS.maxTotalBytes, logEvery = LIMITS.logEvery, keep = () => undefined, log = console.error, nowImpl = Date.now, updatedSince,
} = {}) {
  const seenCursors = new Set();
  const seenRows = new Set();
  const rows = [];
  const skipped = [];
  let skippedCount = 0;
  let totalBytes = 0;
  const dropped = {};
  const started = nowImpl();
  let rawRows = 0;
  let cursor = '';
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`page cap (${maxPages}) reached before the feed ended`);
    const remaining = budgetMs - (nowImpl() - started);
    if (remaining <= 0) throw new Error(`time budget (${Math.round(budgetMs / 1000)}s) exhausted before the feed ended`);
    const url = `${base}/v0.1/servers?limit=${LIMITS.pageSize}&version=latest${updatedSince ? `&updated_since=${encodeURIComponent(updatedSince)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let res;
    try {
      res = await getJson(url, { fetchImpl, timeoutMs: Math.min(LIMITS.timeoutMs, remaining) });
    } catch (e) {
      // The clamped per-request signal can fire a millisecond before the clock check sees the budget spent: if the
      // request was aborted and the clamp was the binding limit, that IS the budget running out.
      const aborted = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /abort|timed? ?out/i.test(String(e?.message));
      const clamped = remaining < LIMITS.timeoutMs;
      if (nowImpl() - started >= budgetMs || (clamped && aborted)) throw new Error(`time budget (${Math.round(budgetMs / 1000)}s) exhausted before the feed ended (${e.message})`);
      throw e;
    }
    const { status, json, bytes } = res;
    if (status !== 200) throw new Error('list endpoint returned 404');
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) throw new Error(`total byte cap (${maxTotalBytes}) exceeded`);
    const p = parsePage(json);
    // Skipped rows still count toward the raw cap, so an all-skipped feed cannot walk forever.
    rawRows += p.skipped.length;
    skippedCount += p.skipped.length;
    for (const sk of p.skipped) if (skipped.length < LIMITS.maxSkippedKept) skipped.push(sk);
    if (rawRows > maxRawRows) throw new Error(`raw row cap (${maxRawRows}) exceeded`);
    let fresh = 0;
    for (const row of p.rows) {
      const key = `${row.server.name}@${row.server.version}`;
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      fresh++;
      rawRows++;
      if (rawRows > maxRawRows) throw new Error(`raw row cap (${maxRawRows}) exceeded`);
      const why = keep(row);
      if (why) { dropped[why] = (dropped[why] ?? 0) + 1; continue; }
      rows.push(row);
    }
    if ((page + 1) % logEvery === 0) log(`fetch progress: ${page + 1} pages, ${rawRows} raw rows, ${rows.length} kept`);
    if (!p.cursor) return { rows, skipped, skippedCount, pages: page + 1, rawRows, dropped };
    if (seenCursors.has(p.cursor)) throw new Error('cursor loop detected');
    if (fresh === 0 && p.skipped.length === 0) throw new Error('page added no new rows (cursor loop)');
    seenCursors.add(p.cursor);
    cursor = p.cursor;
  }
}

// FB-036: GitHub repository quality signal for the top of the candidate queue. Read-only, metadata only.
//
// Score (documented here and in the PR body): rejected outright if the repo is archived or `pushed_at` is older than
// 12 months; otherwise score = log10(1 + stars) + 0.5 if the repo is at least 180 days old. Higher ranks first inside a
// tier; ties fall back to the registry's own newest-first order. Candidates without a GitHub repo are unscored and rank
// after scored ones in their tier. Every number from the API is untrusted: it must be a finite, in-range value.
import { readBody } from './fetch-official.mjs';

const DAY = 86_400_000;
export const STALE_AFTER_MS = 365 * DAY;
const SEG = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_STARS = 10_000_000;

/** `{owner, repo}` from a plain https://github.com/<owner>/<repo>[.git][/] URL, else undefined. The result goes into an API URL, so it is strictly validated. */
export function githubRepoOf(url) {
  if (typeof url !== 'string' || url.length > 300) return undefined;
  let u;
  try { u = new URL(url); } catch { return undefined; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port || u.search || u.hash) return undefined;
  const segs = u.pathname.replace(/\/$/, '').split('/');
  if (segs.length !== 3) return undefined;
  const owner = segs[1];
  const repo = segs[2].replace(/\.git$/, '');
  for (const s of [owner, repo]) if (!SEG.test(s) || s === '.' || s === '..') return undefined;
  return { owner, repo };
}

/** Validate untrusted API JSON into `{stars, archived, pushedAt, createdAt}` (epoch ms), or undefined if unusable. */
export function parseRepoMeta(j) {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const { stargazers_count: s, archived, pushed_at, created_at } = j;
  if (typeof archived !== 'boolean') return undefined;
  if (!Number.isInteger(s) || s < 0 || s > MAX_STARS) return undefined;
  const pushedAt = Date.parse(pushed_at);
  const createdAt = Date.parse(created_at);
  if (!Number.isFinite(pushedAt) || !Number.isFinite(createdAt)) return undefined;
  return { stars: s, archived, pushedAt, createdAt };
}

/** Pure ranking decision: {reject: 'repo-archived'|'repo-stale'} or {score}. */
export function scoreRepo(meta, nowMs) {
  if (meta.archived) return { reject: 'repo-archived' };
  if (nowMs - meta.pushedAt > STALE_AFTER_MS) return { reject: 'repo-stale' };
  return { score: Math.log10(1 + meta.stars) + (nowMs - meta.createdAt >= 180 * DAY ? 0.5 : 0) };
}

/**
 * One GET /repos/{owner}/{repo}. Never throws: returns {meta} or {error} where error is
 * 'not-found' | 'rate-limited' | 'unavailable'. The token (optional, read-only) is sent only to api.github.com and never logged.
 */
export async function fetchRepoMeta(owner, repo, { token, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!SEG.test(owner) || !SEG.test(repo) || owner === '..' || repo === '..' || owner === '.' || repo === '.') return { error: 'unavailable' };
  try {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'mcpambassador-registry-sync' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { signal: AbortSignal.timeout(timeoutMs), headers, redirect: 'error' });
    if (res.status === 404) return { error: 'not-found' };
    if (res.status === 429 || (res.status === 403 && res.headers?.get?.('x-ratelimit-remaining') === '0')) return { error: 'rate-limited' };
    if (!res.ok) return { error: 'unavailable' };
    const meta = parseRepoMeta(JSON.parse((await readBody(res, 256 * 1024)).text));
    return meta ? { meta } : { error: 'unavailable' };
  } catch { return { error: 'unavailable' }; }
}

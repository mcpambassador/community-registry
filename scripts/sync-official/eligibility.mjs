// Eligibility filter for official-registry candidates (ADR-024 §4.3). Pure: no I/O, no network.
// Every function returns data; `evaluate` returns {ok:true, plan} or {ok:false, reason, detail}.

export const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

export const RESERVED_SLUGS = new Set([
  'filesystem', 'fetch', 'github', 'git', 'memory', 'time', 'sqlite', 'postgres',
  'everything', 'sequential-thinking', 'puppeteer', 'slack', 'gitlab',
]);

/** Too generic to hand to one publisher: always gets the `<ns>-<name>` form. */
export const GENERIC_SLUGS = new Set(['mcp', 'server', 'mcp-server', 'server-mcp', 'api', 'app', 'tools', 'agent', 'service', 'client', 'test', 'demo', 'example']);

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const PYPI_PLAIN_VERSION = /^\d+(?:\.\d+){0,3}$/;
const ARG_VALUE = /^[A-Za-z0-9._:/@=-]{1,200}$/;
const NAMED_FLAG = /^--?[a-z][a-z0-9-]{0,40}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const NPM_HOSTS = new Set(['https://registry.npmjs.org', 'https://registry.npmjs.org/']);
const PYPI_HOSTS = new Set(['https://pypi.org', 'https://pypi.org/', 'https://pypi.org/simple', 'https://pypi.org/simple/']);

/** Runner-changing or source-redirecting flags: rejected outright (S5). */
const REJECTED_FLAGS = new Set([
  '--registry', '--index-url', '-i', '--extra-index-url', '--find-links', '-f', '-c', '--constraint', '--from',
  '--with', '--with-requirements', '--with-editable', '--config', '--userconfig', '--prefix', '--cache',
  '--index', '--default-index', '--python', '-p', '--directory', '--project', '--script', '--env-file',
  '--no-config', '--allow-insecure-host', '--trusted-host', '--cert', '--client-cert',
]);

/** Optimal-string-alignment (restricted Damerau-Levenshtein) distance. */
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return Math.abs(m - n);
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Closest name within the threshold (≤2 for names of 6+ chars, ≤1 for shorter), never an exact match. */
export function nearMatch(value, known) {
  const limit = value.length >= 6 ? 2 : 1;
  let best;
  for (const k of known) {
    if (k === value) continue;
    const dist = editDistance(value, k);
    if (dist <= limit && (!best || dist < best.dist)) best = { match: k, dist };
  }
  return best;
}

const slugPart = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Split `ns/thing` and compute the namespace label, owner and proven domain. */
export function parseOfficialName(name) {
  const m = /^([A-Za-z0-9.-]{1,120})\/([A-Za-z0-9._-]{1,120})$/.exec(name);
  if (!m) return undefined;
  const [, ns, thing] = m;
  const labels = ns.split('.');
  if (labels.length < 2) return undefined;
  if (labels[0] === 'io' && labels[1] === 'github' && labels.length === 3) {
    const owner = labels[2];
    return { ns, thing, kind: 'github', owner, label: slugPart(owner), domain: `${owner.toLowerCase()}.github.io`, maintainer: owner };
  }
  const domain = [...labels].reverse().join('.');
  return { ns, thing, kind: 'domain', owner: domain, label: slugPart(labels[1]), domain, maintainer: domain };
}

/** `host` equals `domain` or is a subdomain of it. */
export function hostMatchesDomain(host, domain) {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** Slug rule (§4.3(4)): bare slug unless reserved/taken, then forced `<ns>-<name>`. */
export function chooseSlug(parsed, takenSlugs) {
  const bare = slugPart(parsed.thing);
  const forced = `${parsed.label}-${bare}`.replace(/^-+|-+$/g, '');
  const bareOk = /^[a-z0-9][a-z0-9-]*$/.test(bare);
  if (bareOk && !RESERVED_SLUGS.has(bare) && !GENERIC_SLUGS.has(bare) && !takenSlugs.has(bare)) return { slug: bare, forced: false };
  if (/^[a-z0-9][a-z0-9-]*$/.test(forced) && !RESERVED_SLUGS.has(forced) && !takenSlugs.has(forced)) return { slug: forced, forced: true };
  return undefined;
}

/**
 * Turn upstream packageArguments into extra argv, or reject. Accepts only literal positional values and
 * plain named flags with literal values; anything user-supplied, templated, URL-like or runner-changing is rejected.
 * runtimeArguments (flags for npx/uvx themselves) are not accepted at all.
 */
export function mapArguments(pkg) {
  if (Array.isArray(pkg.runtimeArguments) && pkg.runtimeArguments.length) return { error: 'runtimeArguments are not accepted' };
  const argv = [];
  for (const a of pkg.packageArguments ?? []) {
    if (!a || typeof a !== 'object') return { error: 'malformed argument' };
    const value = a.value;
    if (a.isRepeated || (a.variables && Object.keys(a.variables).length)) return { error: 'templated or repeated argument' };
    if (typeof value !== 'string' || !ARG_VALUE.test(value)) return { error: 'argument value missing or outside the allowed shape' };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { error: 'argument looks like a URL' };
    if (value.includes('${')) return { error: 'argument contains a placeholder' };
    if (a.type === 'positional') {
      if (value.startsWith('-')) return { error: 'positional value looks like a flag' };
      argv.push(value);
    } else if (a.type === 'named') {
      const flag = typeof a.name === 'string' ? a.name : '';
      if (!NAMED_FLAG.test(flag) || REJECTED_FLAGS.has(flag)) return { error: `flag ${flag.slice(0, 40)} is not allowed` };
      if (/^@[^/]+:registry=/.test(flag) || /registry/i.test(flag)) return { error: 'registry override' };
      argv.push(flag, value);
    } else {
      return { error: 'unknown argument type' };
    }
  }
  return { argv };
}

function mapEnvVars(vars) {
  const out = [];
  for (const v of vars ?? []) {
    if (!v || typeof v.name !== 'string' || !ENV_NAME.test(v.name)) return { error: 'environment variable name outside the allowed shape' };
    out.push({
      name: v.name,
      description: typeof v.description === 'string' ? v.description : '',
      required: v.isRequired === true,
      secret: v.isSecret === true,
    });
  }
  return { vars: out };
}

function isPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) return undefined;
  return u;
}

/**
 * Evaluate one list row. `ctx`: { takenSlugs:Set, existingOfficialNames:Set, knownSlugs:Set, knownPackages:Set,
 * denyNames:Set, denyPackages:Set }.  Returns {ok:true, plan} or {ok:false, reason, detail?}.
 */
export function evaluate(row, ctx) {
  const s = row.server;
  const meta = row._meta?.[OFFICIAL_META_KEY];
  if (meta?.status !== 'active') return { ok: false, reason: 'status-not-active', detail: String(meta?.status ?? 'unknown').slice(0, 40) };
  if (meta.isLatest !== true) return { ok: false, reason: 'not-latest' };
  const parsed = parseOfficialName(s.name);
  if (!parsed) return { ok: false, reason: 'bad-name' };
  if (ctx.denyNames.has(s.name)) return { ok: false, reason: 'deny-listed' };
  if (ctx.existingOfficialNames.has(s.name)) return { ok: false, reason: 'already-synced' };

  const pkgs = Array.isArray(s.packages) ? s.packages : [];
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  const usablePkgs = pkgs.filter(p => p && (p.registryType === 'npm' || p.registryType === 'pypi'));
  const usableRemotes = remotes.filter(r => r && r.type === 'streamable-http');
  const usable = usablePkgs.length + usableRemotes.length;
  if (usable === 0) {
    const kinds = [...pkgs.map(p => p?.registryType), ...remotes.map(r => r?.type)].filter(x => typeof x === 'string').slice(0, 4).join(',');
    return { ok: false, reason: 'unsupported-type', detail: kinds || 'none' };
  }
  if (usable > 1) return { ok: false, reason: 'ambiguous-multiple-runnable' };

  const flags = new Set();
  const slugChoice = chooseSlug(parsed, ctx.takenSlugs);
  if (!slugChoice) return { ok: false, reason: 'slug-unavailable' };
  if (ctx.denyNames.has(slugChoice.slug)) return { ok: false, reason: 'deny-listed' };
  if (slugChoice.forced) flags.add('forced-slug');
  const nm = nearMatch(slugChoice.slug, new Set([...ctx.knownSlugs, ...RESERVED_SLUGS, ...ctx.takenSlugs]));
  if (nm) { flags.add('name-near-match'); }

  const base = { officialName: s.name, parsed, slug: slugChoice.slug, flags, nearMatches: nm ? [nm.match] : [] };

  if (usablePkgs.length === 1) {
    const p = usablePkgs[0];
    const isNpm = p.registryType === 'npm';
    if (p.transport?.type !== 'stdio') return { ok: false, reason: 'unsupported-transport', detail: String(p.transport?.type).slice(0, 30) };
    if (p.registryBaseUrl !== undefined && !(isNpm ? NPM_HOSTS : PYPI_HOSTS).has(p.registryBaseUrl)) return { ok: false, reason: 'custom-registry' };
    const idOk = typeof p.identifier === 'string' && (isNpm ? NPM_NAME : PYPI_NAME).test(p.identifier) && p.identifier.length <= 214;
    if (!idOk) return { ok: false, reason: 'bad-package-identifier' };
    if (ctx.denyPackages.has(p.identifier)) return { ok: false, reason: 'deny-listed' };
    const verOk = typeof p.version === 'string' && (isNpm ? PLAIN_VERSION : PYPI_PLAIN_VERSION).test(p.version);
    if (!verOk) return { ok: false, reason: 'version-not-exact' };
    const args = mapArguments(p);
    if (args.error) return { ok: false, reason: 'arguments-rejected', detail: args.error };
    const env = mapEnvVars(p.environmentVariables);
    if (env.error) return { ok: false, reason: 'env-rejected', detail: env.error };
    const pn = nearMatch(p.identifier.toLowerCase(), ctx.knownPackages);
    if (pn) { flags.add('name-near-match'); base.nearMatches.push(pn.match); }
    if (env.vars.some(v => v.secret)) flags.add('secret-env');
    if (parsed.kind !== 'github' && !/^https:\/\/(github|gitlab)\.com\//.test(s.repository?.url ?? '')) flags.add('repo-not-github-gitlab');
    return { ok: true, plan: { ...base, kind: p.registryType, identifier: p.identifier, version: p.version, argv: args.argv, env: env.vars } };
  }

  // remote
  const r = usableRemotes[0];
  const url = isPublicHttpsUrl(r.url);
  if (!url) return { ok: false, reason: 'remote-not-public-https' };
  if (String(r.url).includes('{') || (r.variables && Object.keys(r.variables).length)) return { ok: false, reason: 'remote-templated-url', detail: 'manual' };
  if (Array.isArray(r.headers) && r.headers.length) return { ok: false, reason: 'remote-needs-headers', detail: 'manual' };
  if (!hostMatchesDomain(url.hostname, parsed.domain)) flags.add('host-mismatch');
  flags.add('pinning-none');
  flags.add('remote-auth-unverified');
  return { ok: true, plan: { ...base, kind: 'remote', url: url.href, version: PLAIN_VERSION.test(s.version) ? s.version : '1.0.0', argv: [], env: [] } };
}

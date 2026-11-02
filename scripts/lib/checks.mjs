// Pure registry checks shared by CI (scripts/ci/check.mjs) and the official-registry sync.
// No I/O and no network in this file. ADR-024.

import { checkCatalogEntry, credentialEnvNames } from '../vendor/runner-guard.mjs';

export const SYNC_BRANCH_PREFIX = 'sync/official-';

/** Characters never allowed in free text: C0/C1 controls (except \n \t in description), zero-width, bidi. */
const BAD_TEXT = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' + // C0/C1 controls (not \\t \\n \\r)
    '\\u200B-\\u200F\\u2028\\u2029\\u2060-\\u2064\\uFEFF' + // zero-width, line/paragraph separators
    '\\u202A-\\u202E\\u2066-\\u2069' + // bidirectional overrides and isolates
    ']',
  'u'
);

/** Remove the characters BAD_TEXT rejects (used by the sync mapper on upstream text). */
export function stripUnsafeText(text) {
  return String(text).replace(new RegExp(BAD_TEXT.source, 'gu'), '');
}

const NPM_PIN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PYPI_PIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?==\d+(?:\.\d+)*(?:(?:\.|-|_)?(?:a|b|rc|post|dev)\d*)*(?:\+[A-Za-z0-9.]+)?$/;

/** True when `sync` PR detection applies: head branch prefix OR the configured sync App as author. */
export function isSyncPr({ headRef, author, appLogin }) {
  if (typeof headRef === 'string' && headRef.startsWith(SYNC_BRANCH_PREFIX)) return true;
  return Boolean(appLogin) && typeof author === 'string' && author === appLogin;
}

/** The package argument of an npx/uvx command, or undefined (not a package-runner command). */
export function packageArg(command) {
  if (!Array.isArray(command) || command.length === 0) return undefined;
  const [runner, ...rest] = command;
  if (runner !== 'npx' && runner !== 'uvx') return undefined;
  const arg = rest.find(a => typeof a === 'string' && !a.startsWith('-'));
  return { runner, arg };
}

/** null when exactly pinned (or not a package-runner command), else a reason. */
export function pinProblem(command) {
  const p = packageArg(command);
  if (!p) return null;
  if (p.arg === undefined) return `${p.runner} command has no package argument`;
  const ok = p.runner === 'npx' ? NPM_PIN.test(p.arg) : PYPI_PIN.test(p.arg);
  return ok ? null : `${p.runner} package "${p.arg}" is not an exact version pin (${p.runner === 'npx' ? 'name@x.y.z' : 'name==x.y.z'})`;
}

function stringsOf(entry) {
  const out = [];
  for (const k of ['name', 'display_name', 'description', 'maintainer', 'category']) {
    if (typeof entry[k] === 'string') out.push([k, entry[k]]);
  }
  if (Array.isArray(entry.tags)) entry.tags.forEach((t, i) => typeof t === 'string' && out.push([`tags[${i}]`, t]));
  return out;
}

/** Free-text lint: control / zero-width / bidi characters; plain http:// URLs in display text. */
export function lintEntryText(entry) {
  const errors = [];
  for (const [k, v] of stringsOf(entry)) {
    const text = k === 'description' ? v.replace(/[\n\t]/g, ' ') : v;
    if (BAD_TEXT.test(text)) errors.push(`[${entry.name}] ${k} contains control, zero-width or bidirectional characters`);
    if ((k === 'description' || k === 'display_name') && /\bhttp:\/\//i.test(v)) {
      errors.push(`[${entry.name}] ${k} contains a non-https URL`);
    }
  }
  return errors;
}

const byName = mcps => new Map((mcps ?? []).map(m => [m.name, m]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Added or changed entries (head vs base), by name. */
export function changedEntries(baseMcps, headMcps) {
  const base = byName(baseMcps);
  const added = [];
  const changed = [];
  for (const m of headMcps ?? []) {
    const b = base.get(m.name);
    if (!b) added.push(m);
    else if (!same(b, m)) changed.push(m);
  }
  const head = byName(headMcps);
  const removed = [...base.keys()].filter(n => !head.has(n));
  return { added, changed, removed };
}

/**
 * Universal checks (every PR). `allPins` enforces the pin rule on the whole registry (set once TD-018 is done);
 * otherwise it applies to added and changed entries.
 */
/**
 * Env names no credential may ever bind: they select live trading, the data endpoint or the tool
 * surface of the MCP. Extend this list when a catalog entry fixes a safety-relevant variable.
 */
export const LOCKED_ENV_NAMES = ['ALPACA_PAPER_TRADE', 'DATA_API_URL', 'ALPACA_TOOLSETS'];

export function lockedEnvBinding(m) {
  const locked = new Set(LOCKED_ENV_NAMES.map(n => n.toLowerCase()));
  for (const name of credentialEnvNames(m.credential_schema)) {
    if (locked.has(String(name).toLowerCase())) {
      return `credential_schema may not bind the locked environment variable ${String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '?').slice(0, 64)}`;
    }
  }
  return null;
}

/**
 * TD-049 (CI half): a credential field must not bind an env var that config.env fixes. The server
 * lets the fixed value win, but a catalog that offers the field anyway misleads admins and users.
 * `KEY: ${KEY}` (same-name placeholder) is not a fixed value. Names are compared case-insensitively.
 */
export function fixedEnvCollision(m) {
  const env = m.config?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const fixed = new Set(
    Object.entries(env)
      .filter(([k, v]) => String(v) !== '${' + k + '}')
      .map(([k]) => k.toLowerCase())
  );
  if (fixed.size === 0) return null;
  for (const name of credentialEnvNames(m.credential_schema)) {
    if (fixed.has(String(name).toLowerCase())) {
      return `credential_schema binds an environment variable that config.env fixes: ${String(name).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 64)}`;
    }
  }
  return null;
}

/**
 * TD-048: a static-credential entry must say which environment variable each required credential
 * fills, or Ambassador cannot inject the user's secret. Returns the required property names that
 * have no non-empty `env_var` (empty when the entry is not static or is fully mapped).
 */
export function staticCredentialProblems(m) {
  if (m?.auth_type !== 'static') return [];
  const props = m.credential_schema?.properties ?? {};
  const required = Array.isArray(m.credential_schema?.required) ? m.credential_schema.required : [];
  return required.filter(k => {
    const ev = props[k]?.env_var;
    return typeof ev !== 'string' || ev.trim() === '';
  });
}

export function universalChecks({ baseMcps, headMcps, allPins = false }) {
  const errors = [];
  const { added, changed } = changedEntries(baseMcps, headMcps);
  const pinScope = allPins ? headMcps : [...added, ...changed];
  for (const m of pinScope) {
    const why = pinProblem(m.config?.command);
    if (why) errors.push(`[${m.name}] ${why}`);
    // Runner guard (TD-039 / TD-043): same rule the server applies at install and spawn.
    const bad = checkCatalogEntry({
      config: m.config,
      credential_schema: m.credential_schema,
      oauth_access_token_env_var: m.oauth_config?.access_token_env_var,
    });
    if (bad) errors.push(`[${m.name}] ${bad}`);
    const locked = lockedEnvBinding(m);
    if (locked) errors.push(`[${m.name}] ${locked}`);
    const clash = fixedEnvCollision(m);
    if (clash) errors.push(`[${m.name}] ${clash}`);
  }
  for (const m of added) {
    if (m.verified === true) errors.push(`[${m.name}] a new entry cannot be added with verified: true`);
  }
  for (const m of [...added, ...changed]) errors.push(...lintEntryText(m));
  // TD-048: changed/added entries only (never --all-pins), so existing entries are fixed as they are touched.
  for (const m of [...added, ...changed]) {
    const missing = staticCredentialProblems(m);
    if (missing.length) {
      const names = missing.map(k => String(k).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 64)).join(', ');
      errors.push(`[${m.name}] auth_type static: required credential(s) without env_var: ${names}`);
    }
  }
  return errors;
}

// ---- Diff-scope for sync PRs (ADR-024 M2) ----
const SYNC_EDITABLE_TOP = new Set(['version', 'package_integrity', 'synced_at', 'description', 'credential_schema', 'flags', 'dependencies_pinned']);
const SYNC_EDITABLE_CONFIG = new Set(['command', 'env']);
const SYNC_ADDABLE_TOP = new Set([
  'name', 'display_name', 'description', 'icon_url', 'transport_type', 'config', 'auth_type', 'isolation_mode',
  'requires_user_credentials', 'credential_schema', 'tags', 'category', 'repository_url', 'documentation_url',
  'version', 'maintainer', 'verified', 'source', 'official_name', 'namespace_verification', 'package_integrity',
  'dependencies_pinned', 'pinning', 'flags', 'synced_at',
]);

/** Only the package argument (same package name, any version) may differ between two commands. */
function commandOnlyPinDiffers(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a[0] !== b[0]) return false;
  const pa = packageArg(a);
  const pb = packageArg(b);
  if (!pa || !pb) return false;
  const strip = (s, runner) => (runner === 'npx' ? s.replace(/@[^@/]*$/, '') : s.replace(/==.*$/, ''));
  return a.every((x, i) => x === b[i] || (x === pa.arg && b[i] === pb.arg && strip(x, pa.runner) === strip(pb.arg ?? '', pb.runner)));
}

export function diffScope({ baseMcps, headMcps, changedFiles }) {
  const errors = [];
  const files = [...(changedFiles ?? [])].sort();
  if (!(files.length === 1 && files[0] === 'registry.yaml')) {
    errors.push(`sync PR may change only registry.yaml (changed: ${files.join(', ') || 'none'})`);
  }
  const { added, changed, removed } = changedEntries(baseMcps, headMcps);
  for (const n of removed) errors.push(`[${n}] sync PR must not delete entries`);
  const base = byName(baseMcps);
  for (const m of added) {
    if (m.source !== 'official-registry') errors.push(`[${m.name}] added entry must have source: official-registry`);
    if (m.oauth_config !== undefined) errors.push(`[${m.name}] sync must not add oauth_config`);
    if (m.verified === true) errors.push(`[${m.name}] sync must not add verified: true`);
    for (const k of Object.keys(m)) if (!SYNC_ADDABLE_TOP.has(k)) errors.push(`[${m.name}] unexpected field "${k}" on a synced entry`);
  }
  for (const m of changed) {
    const b = base.get(m.name);
    if (b.source !== 'official-registry' || m.source !== 'official-registry') {
      errors.push(`[${m.name}] sync may only edit entries with source: official-registry`);
      continue;
    }
    for (const k of new Set([...Object.keys(b), ...Object.keys(m)])) {
      if (same(b[k], m[k])) continue;
      if (k === 'config') {
        for (const ck of new Set([...Object.keys(b.config ?? {}), ...Object.keys(m.config ?? {})])) {
          if (same(b.config?.[ck], m.config?.[ck])) continue;
          if (!SYNC_EDITABLE_CONFIG.has(ck)) errors.push(`[${m.name}] sync must not change config.${ck}`);
          else if (ck === 'command' && !commandOnlyPinDiffers(b.config.command, m.config.command)) {
            errors.push(`[${m.name}] sync may only change the version pin in config.command`);
          }
        }
      } else if (!SYNC_EDITABLE_TOP.has(k)) {
        errors.push(`[${m.name}] sync must not change "${k}"`);
      }
    }
  }
  return errors;
}

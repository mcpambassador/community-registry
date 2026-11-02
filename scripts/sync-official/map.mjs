// Map an eligible plan to a registry.yaml entry (ADR-024 §4.4).
// Field-by-field: values come from validated plan fields only. No spread of upstream objects, no upstream
// key is ever used as a property name.
import { stripUnsafeText, lintEntryText } from '../lib/checks.mjs';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const clean = (s, n) => clip(stripUnsafeText(String(s ?? '')).replace(/\s+/g, ' ').trim(), n);
const https = raw => {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
};
const humanize = s => s.split(/[-_.]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Returns { entry } or { error } (text lint failure). */
export function buildEntry(plan, server, enrich, nowIso) {
  const secretOrRequired = plan.env.filter(v => v.secret || v.required);
  const needsCreds = secretOrRequired.length > 0;
  const flags = [...new Set([...plan.flags, ...(enrich.flags ?? [])])].sort();

  const entry = {};
  entry.name = plan.slug;
  entry.display_name = clean(server.title, 100) || humanize(plan.parsed.thing);
  entry.description = clean(server.description, 500) || entry.display_name;
  entry.transport_type = plan.kind === 'remote' ? 'http' : 'stdio';
  if (plan.kind === 'remote') {
    entry.config = { url: plan.url };
  } else {
    const command = plan.kind === 'npm'
      ? ['npx', '-y', `${plan.identifier}@${plan.version}`, ...plan.argv]
      : ['uvx', `${plan.identifier}==${plan.version}`, ...plan.argv];
    entry.config = { command };
    if (secretOrRequired.length) {
      entry.config.env = {};
      for (const v of secretOrRequired) entry.config.env[v.name] = '${' + v.name + '}';
    }
  }
  entry.auth_type = needsCreds ? 'static' : 'none';
  if (needsCreds) {
    entry.credential_schema = { type: 'object', properties: {}, required: secretOrRequired.filter(v => v.required).map(v => v.name) };
    for (const v of secretOrRequired) {
      entry.credential_schema.properties[v.name] = { type: 'string', title: v.name, description: clean(v.description, 200) || v.name, env_var: v.name };
    }
    if (!entry.credential_schema.required.length) delete entry.credential_schema.required;
  }
  entry.isolation_mode = needsCreds ? 'per_user' : 'shared';
  entry.requires_user_credentials = needsCreds;
  entry.category = 'Uncategorized';
  const repo = https(server.repository?.url ?? '');
  if (repo) entry.repository_url = repo;
  const site = https(server.websiteUrl ?? '');
  if (site) entry.documentation_url = site;
  entry.version = plan.version;
  entry.maintainer = clean(plan.parsed.maintainer, 100);
  entry.verified = false;
  entry.source = 'official-registry';
  entry.official_name = plan.officialName;
  entry.namespace_verification = plan.parsed.kind === 'github' ? 'github' : 'unknown';
  if (plan.kind === 'remote') entry.pinning = 'none';
  else {
    entry.package_integrity = enrich.packageIntegrity;
    entry.dependencies_pinned = enrich.dependenciesPinned === true;
  }
  entry.flags = flags;
  entry.synced_at = nowIso;

  const problems = lintEntryText(entry);
  if (problems.length) return { error: problems.join('; ') };
  return { entry };
}

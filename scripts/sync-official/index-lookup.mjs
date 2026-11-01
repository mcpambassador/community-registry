// Metadata-only lookups on npm / PyPI for a specific candidate version (ADR-024 §4.5, §4.7).
// Nothing is installed or executed. Injectable `get` keeps tests offline.
import { getJson } from './fetch-official.mjs';

const enc = name => name.replace('/', '%2f');
const DAY = 86_400_000;

/** Ownership marker must name the official server exactly (not merely contain it). */
export function hasPypiMarker(readme, officialName) {
  if (typeof readme !== 'string') return false;
  const i = readme.indexOf(`mcp-name: ${officialName}`);
  if (i === -1) return false;
  const after = readme[i + `mcp-name: ${officialName}`.length];
  return after === undefined || !/[A-Za-z0-9._/-]/.test(after);
}

export async function lookupCandidate(plan, now, get = getJson) {
  if (plan.kind === 'remote') return { ok: true, flags: [] };
  const flags = [];
  if (plan.kind === 'npm') {
    const doc = await get(`https://registry.npmjs.org/${enc(plan.identifier)}/${plan.version}`);
    if (doc.status !== 200) return { ok: false, reason: 'package-not-found' };
    const d = doc.json;
    if (d?.version !== plan.version) return { ok: false, reason: 'index-version-mismatch' };
    const integrity = d?.dist?.integrity;
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) return { ok: false, reason: 'no-integrity' };
    if (d.mcpName !== plan.officialName) return { ok: false, reason: 'ownership-marker-missing' };
    const dependenciesPinned = d._hasShrinkwrap === true;
    if (!dependenciesPinned) flags.push('dependencies-unpinned');
    try {
      const full = await get(`https://registry.npmjs.org/${enc(plan.identifier)}`);
      const created = Date.parse(full.json?.time?.created);
      if (Number.isFinite(created) && now - created < 30 * DAY) flags.push('new-package');
      if (!Number.isFinite(created)) flags.push('age-unknown');
    } catch { flags.push('age-unknown'); }
    try {
      const dl = await get(`https://api.npmjs.org/downloads/point/last-week/${enc(plan.identifier)}`);
      if (!(dl.json?.downloads >= 1000)) flags.push('low-downloads');
    } catch { flags.push('downloads-unknown'); }
    return { ok: true, packageIntegrity: { npm: integrity }, dependenciesPinned, flags };
  }
  // pypi
  const doc = await get(`https://pypi.org/pypi/${encodeURIComponent(plan.identifier)}/${plan.version}/json`);
  if (doc.status !== 200) return { ok: false, reason: 'package-not-found' };
  const j = doc.json;
  if (j?.info?.version !== plan.version) return { ok: false, reason: 'index-version-mismatch' };
  if (!hasPypiMarker(j.info.description, plan.officialName)) return { ok: false, reason: 'ownership-marker-missing' };
  const files = (j.urls ?? []).filter(f => !f.yanked);
  const digests = [...new Set(files.map(f => f.digests?.sha256).filter(x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)))].sort();
  if (!digests.length) return { ok: false, reason: 'no-integrity' };
  flags.push('dependencies-unpinned', 'pypi-stats-not-checked');
  return { ok: true, packageIntegrity: { pypi: digests }, dependenciesPinned: false, flags };
}

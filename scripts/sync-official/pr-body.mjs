// Generated PR body (ADR-024 §4.6). Every upstream string goes through code(): backticks and newlines
// removed, length capped, wrapped in a code span, so upstream text cannot inject markdown, mentions or links.
const code = (s, n = 120) => '`' + String(s ?? '').replace(/[`\r\n|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) + '`';
const MAX = 60000; // GitHub limit is 65536 characters

const NOISE = new Set(['not-latest', 'already-synced', 'unsupported-type', 'status-not-active']);

export function renderPrBody({ accepted, rejected, skipped, stats, date, dryRun, dropped = {}, scope, watermark }) {
  const L = [];
  L.push(`## Official registry sync ${date}${dryRun ? ' (DRY RUN, no PR is opened)' : ''}`, '');
  L.push('Candidates from the official MCP Registry, mapped to our schema. **Review every row.** Namespace verification proves who published, not that the code is safe. Nothing here is `verified`; entries are additions only.', '');
  L.push(`Fetched ${stats.rows} rows over ${stats.pages} page(s); ${accepted.length} proposed, ${stats.rejected} rejected, ${stats.deferred} deferred by the per-run caps.`, '');
  if (scope) L.push(`Scope: ${watermark ? `incremental scan, updated since ${code(watermark)}` : 'full scan'}; eligible candidates by tier: ${scope.tierCounts[1]} verified-namespace, ${scope.tierCounts[2]} other; proposed: ${scope.acceptedTiers[1]} verified, ${scope.acceptedTiers[2]} other, from ${scope.publishers} publisher(s) (at most ${scope.maxPerPublisher} each; ${scope.cappedByPublisher} held back by that cap).`, '');
  if (accepted.length) {
    L.push('### Proposed additions', '');
    for (const a of accepted) {
      const e = a.entry;
      L.push(`#### ${code(e.name)}  ←  ${code(a.plan.officialName)}`, '');
      L.push(`- namespace: ${code(a.plan.parsed.ns)} (${e.namespace_verification}${e.namespace_verification === 'unknown' ? ': the registry proved it by DNS or HTTP; confirm manually' : ''}); maintainer ${code(e.maintainer)}`);
      L.push(`- transport: ${e.transport_type}; ${e.config.command ? 'command ' + code(e.config.command.join(' '), 200) : 'url ' + code(e.config.url, 200)}`);
      if (e.repository_url) L.push(`- repository: ${code(e.repository_url, 200)}`);
      const secrets = a.plan.env.filter(v => v.secret).map(v => v.name);
      const others = a.plan.env.filter(v => !v.secret && v.required).map(v => v.name);
      if (secrets.length) L.push(`- **secret env vars requested:** ${secrets.map(n => code(n, 64)).join(', ')}`);
      if (others.length) L.push(`- required env vars: ${others.map(n => code(n, 64)).join(', ')}`);
      if (e.package_integrity?.npm) L.push(`- npm integrity: ${code(e.package_integrity.npm, 140)}`);
      if (e.package_integrity?.pypi) L.push(`- PyPI file sha256 set: ${e.package_integrity.pypi.length} file(s)`);
      L.push(`- flags: ${e.flags.length ? e.flags.map(f => code(f, 40)).join(', ') : 'none'}`);
      if (a.plan.nearMatches.length) L.push(`- **near-match, acknowledge before merging:** ${a.plan.nearMatches.map(n => code(n, 80)).join(', ')}`);
      if (e.flags.includes('host-mismatch')) L.push(`- **host-mismatch, acknowledge before merging:** the remote host is not under ${code(a.plan.parsed.domain)}`);
      if (e.pinning === 'none') L.push('- remote endpoint: no version pin can protect it (it can change behavior without a version change)');
      if (e.dependencies_pinned === false && e.pinning !== 'none') L.push('- dependencies are not pinned (residual risk, see ADR-024 §4.5)');
      L.push('');
    }
  }
  const byReason = new Map();
  for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  for (const [reason, n] of Object.entries(dropped)) byReason.set(reason, (byReason.get(reason) ?? 0) + n);
  L.push('### Rejected (counts by reason)', '');
  for (const [reason, n] of [...byReason].sort()) L.push(`- ${code(reason, 60)}: ${n}`);
  const interesting = rejected.filter(r => !NOISE.has(r.reason)).slice(0, 60);
  if (interesting.length) {
    L.push('', '<details><summary>Rejected for a substantive reason (first 60)</summary>', '', '| Name | Reason | Detail |', '|---|---|---|');
    for (const r of interesting) L.push(`| ${code(r.name, 80)} | ${code(r.reason, 60)} | ${code(r.detail ?? '', 80)} |`);
    L.push('', '</details>');
  }
  const skippedN = stats.skipped ?? skipped.length;
  if (skippedN) L.push('', `Skipped ${skippedN} row(s) with an unknown \`$schema\` or malformed shape.`);
  L.push('', 'To permanently decline a candidate, add it to the denylist; closing this PR does not.');
  L.push('', '---', 'Install-time code execution (postinstall, setup.py) on the Ambassador host is a residual risk accepted for v1; CI never installs candidates. Tool-definition pinning (ADR-021) and approvals (ADR-023) are the runtime controls.');
  const body = L.join('\n');
  return body.length > MAX ? body.slice(0, MAX) + '\n\n_(truncated)_' : body;
}

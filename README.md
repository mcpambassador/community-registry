# MCP Ambassador Community Registry

[![Validation](https://github.com/mcpambassador/community-registry/actions/workflows/validate.yml/badge.svg)](https://github.com/mcpambassador/community-registry/actions/workflows/validate.yml) ![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg) [![Website](https://img.shields.io/badge/docs-mcpambassador.ai-blue.svg)](https://mcpambassador.ai)

`registry.yaml` is a catalog of MCP server configurations that an [MCP Ambassador Server](https://github.com/mcpambassador/server) fetches to populate its marketplace. Admins browse it and install entries from the admin dashboard. Installing an entry still goes through the server's normal MCP lifecycle and tool review.

## Contents

- `registry.yaml`: the catalog. Each entry has the transport (`stdio` or `http`), launch command or URL, env vars, auth type and credential schema, isolation mode, category, tags, and maintainer metadata. Browse the file or the server's marketplace for the current list.
- `schema/registry.schema.json`: JSON Schema (draft-07) every entry must satisfy.
- `scripts/ci/`: validation run by CI (`npm run check`), including exact version pinning for `npx`/`uvx` commands.
- `scripts/sync-official/`: the official-registry sync (below).

## How servers use it

By default a server reads `registry.yaml` from this repo through the GitHub contents API. Override with `REGISTRY_URL` (and `REGISTRY_TOKEN` for a private repo); `REGISTRY_ENABLED=false` turns it off. The server keeps only the fields it needs; extra fields such as sync provenance are not stored in its catalog. Schema changes must stay compatible with the server's registry service.

## Contributing an entry

1. Fork the repo and add an entry to `registry.yaml` following the schema.
2. Pin `stdio` packages to an exact version (`pkg@1.2.3` for npx, `pkg==1.2.3` for uvx). Never use `@latest`, ranges or bare names.
3. Do not set `verified: true` (maintainers only) and do not put secrets in entries.
4. Open a PR; CI validates the schema and policy checks, and a maintainer reviews.

Full entry format and categories: [CONTRIBUTING.md](CONTRIBUTING.md). To report a malicious or compromised entry privately, see [.github/SECURITY.md](.github/SECURITY.md).

```bash
npm install
npm run check   # validates registry.yaml: schema, policy, all pins
npm test
```

## Official registry sync

A GitHub Action, [`sync-official-registry.yml`](.github/workflows/sync-official-registry.yml), proposes entries from the official MCP Registry (ADR-024). It is a candidate feed, not a trust root:

- Weekly scheduled runs are dry runs only; real runs are started manually.
- Intake is curated: per-run and per-publisher caps, publisher and repo checks, a deny-list.
- It opens a PR only. It never merges, never pushes to `main`, and never installs or runs a candidate package. A human reviews every PR.
- Synced entries carry `source: official-registry` and face a stricter diff scope in CI.

## Related

[Server](https://github.com/mcpambassador/server) · [Client](https://github.com/mcpambassador/client) · [Docs](https://mcpambassador.ai/docs/registry)

## License

Apache License 2.0, see [LICENSE](./LICENSE).

# MCP Ambassador Community Registry

A curated registry of MCP (Model Context Protocol) servers for use with [MCP Ambassador](https://github.com/zervin/mcpambassador_server).

## What is this?

This repository contains `registry.yaml` — a machine-readable catalog of MCP servers that MCP Ambassador can browse, search, and install with one click from the admin dashboard.

## Current MCPs

| Name | Category | Auth | Transport | Verified |
|------|----------|------|-----------|----------|
| GitHub | Developer Tools | OAuth2 | HTTP | ✅ |
| Context7 | Developer Tools | None | stdio | ✅ |
| Alpha Vantage | Finance & Data | API Key | HTTP | ✅ |
| Tavily Search | Search & Web | API Key | stdio | ✅ |
| Filesystem | Utilities | None | stdio | ✅ |
| Notion | Productivity | API Key | stdio | ✅ |

## Using with MCP Ambassador

MCP Ambassador automatically fetches this registry. No configuration needed — it uses:

```
https://raw.githubusercontent.com/zervin/mcpambassador_community_mcps/main/registry.yaml
```

To use a custom or private registry, set the `REGISTRY_URL` environment variable.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add or update MCP entries.

## Schema

The registry format is defined in [schema/registry.schema.json](schema/registry.schema.json).

## License

MIT — see [LICENSE](LICENSE).
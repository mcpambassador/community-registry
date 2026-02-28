# MCP Ambassador Community Registry

A curated, community-maintained registry of MCP server configurations for use with MCP Ambassador. Browse, search, and import with one click from the admin dashboard.

![Validation](https://github.com/mcpambassador/community-registry/actions/workflows/validate.yml/badge.svg) ![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg) ![MCPs](https://img.shields.io/badge/MCPs-38-brightgreen.svg) [![Website](https://img.shields.io/badge/docs-mcpambassador.ai-blue.svg)](https://mcpambassador.ai)

## What Is This

This repository contains `registry.yaml`, a machine-readable catalog of pre-validated MCP server configurations. Each entry includes the transport type, launch command, environment variables, credential requirements, and metadata. MCP Ambassador servers fetch this registry automatically to populate their marketplace.

## Registry Contents

**Developer Tools**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| GitHub | GitHub API with 40+ tools for repos, issues, PRs, and more | HTTP | OAuth2 |
| Context7 | Library documentation search and retrieval | stdio | API key |
| Sentry | Error tracking and performance monitoring | stdio | API key |
| GitLab | GitLab API for repositories, issues, and CI/CD | stdio | API key |

**Search and Web**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Tavily Search | Web search API for AI applications | stdio | API key |
| Brave Search | Privacy-focused web search | stdio | API key |
| Exa | Neural search engine | stdio | API key |
| Fetch | HTTP fetching and content extraction | stdio | None |

**Database and Backend**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Supabase | Supabase database and auth management | stdio | API key |
| MongoDB | MongoDB database operations | stdio | API key |
| PostgreSQL | PostgreSQL database access | stdio | API key |
| SQLite | Local SQLite database operations | stdio | None |

**Browser and Automation**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Puppeteer (deprecated) | Browser automation using Puppeteer | stdio | None |
| Playwright | Browser automation and testing by Microsoft | stdio | None |

**Productivity**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Notion | Notion workspace management | stdio | API key |
| Monday.com | Monday.com project management | stdio | API key |
| Todoist | Task management with Todoist | stdio | API key |

**Finance and Data**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Alpha Vantage | Financial market data and analysis | HTTP | API key |

**Utilities**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Filesystem | Local filesystem access | stdio | None |
| MarkItDown | Document conversion to Markdown | stdio | None |
| Time | Time and timezone utilities | stdio | None |
| Memory | Persistent memory and knowledge graph | stdio | None |

**Data and Web Scraping**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Firecrawl | Web scraping and crawling | stdio | API key |

**Communication**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Slack | Slack workspace integration | stdio | API key |

**Automation and Integration**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Zapier | Workflow automation across 5000+ apps | stdio | API key |

**AI and Reasoning**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Sequential Thinking | Dynamic problem-solving through sequential reasoning | stdio | None |
| GitHub Models | AI model inference via GitHub Models | stdio | API key |

**Visualization**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Mermaid | Diagram generation with Mermaid syntax | stdio | None |

**Design**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Figma | Figma design file access | stdio | API key |

**Commerce and Payments**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Stripe | Payment processing with Stripe | stdio | API key |

**Cloud and Infrastructure**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Cloudflare | Cloudflare services management | stdio | API key |
| AWS Knowledge Base | AWS Bedrock Knowledge Base retrieval | stdio | API key |

**DevOps and Monitoring**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Grafana | Grafana dashboard and data source management | stdio | API key |
| Docker | Docker container management | stdio | None |

**Maps and Location**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Google Maps | Google Maps geocoding and directions | stdio | API key |

**Project Management**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Linear | Linear issue and project tracking | stdio | API key |

**Game Development**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| Unity | Unity game engine integration | stdio | None |

**Creative**
| Name | Description | Transport | Credentials |
|------|-------------|-----------|-------------|
| EverArt | AI art generation | stdio | API key |

## How to Use

MCP Ambassador servers fetch this registry automatically:

```
https://raw.githubusercontent.com/mcpambassador/community-registry/main/registry.yaml
```

To use a custom or private registry, set the `REGISTRY_URL` environment variable on your server.

## Contributing

1. Fork this repository
2. Add your entry to `registry.yaml` following the schema
3. Submit a pull request
4. CI validates the YAML schema automatically
5. Maintainers review and merge

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full entry schema and guidelines.

## Schema

The registry format is defined in [schema/registry.schema.json](schema/registry.schema.json).

## Related Projects

| Project | Description |
|---------|-------------|
| [MCP Ambassador Server](https://github.com/mcpambassador/server) | Centralized MCP governance server |
| [@mcpambassador/client](https://github.com/mcpambassador/client) | Lightweight MCP proxy for developer workstations |
| [Documentation](https://mcpambassador.ai) | Full documentation, guides, and API reference |

## License

Apache License 2.0 -- see [LICENSE](./LICENSE).

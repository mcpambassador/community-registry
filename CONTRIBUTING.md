# Contributing to MCP Ambassador Community Registry

Thank you for helping grow the MCP ecosystem!

## Code of Conduct
Please follow our Code of Conduct: see CODE_OF_CONDUCT.md for details on expected behavior and enforcement.

## Security Concerns
If you discover a malicious MCP entry or a security issue with an existing entry, do NOT open a public issue. See .github/SECURITY.md for private reporting.

## Adding a New MCP

1. Fork this repository
2. Edit `registry.yaml` and add your MCP entry
3. Submit a pull request -- validation runs automatically in CI

## Entry Format

Each MCP entry in `registry.yaml` follows this structure:

```yaml
- name: my-mcp-server          # Unique identifier (lowercase, hyphens)
  display_name: "My MCP Server" # Human-readable name
  description: "What it does"   # One-line description
  icon_url: "https://..."       # Optional icon URL
  transport_type: http           # http or stdio
  config:
    url: "https://..."           # For HTTP transport
    # OR
    command: ["npx", "-y", "@scope/package"]  # For stdio transport
    env:                         # Optional environment variables
      KEY: "value"
  auth_type: none                # none, static, or oauth2
  isolation_mode: shared         # shared or per_user
  requires_user_credentials: false
  tags: ["tag1", "tag2"]
  category: "Category Name"
  repository_url: "https://..."  # Source code URL
  documentation_url: "https://..." # Docs URL
  version: "1.0.0"
  maintainer: "Org or Person"
  verified: false                # Only maintainers set true
```

### Auth Types

- **none**: No authentication needed
- **static**: Requires API key or token (add `credential_schema`)
- **oauth2**: Requires OAuth2 flow (add `oauth_config`)

### For Static Auth

Add a `credential_schema` with JSON Schema format:

```yaml
  credential_schema:
    type: object
    properties:
      API_KEY:
        type: string
        title: "API Key"
        description: "How to get this key"
    required:
      - API_KEY
```

### For OAuth2 Auth

Add an `oauth_config`:

```yaml
  oauth_config:
    auth_url: "https://provider.com/oauth/authorize"
    token_url: "https://provider.com/oauth/token"
    scopes: "scope1 scope2"
    client_id_env: "PROVIDER_OAUTH_CLIENT_ID"
    client_secret_env: "PROVIDER_OAUTH_CLIENT_SECRET"
```

## Guidelines

- **Test before submitting**: Ensure the MCP server is accessible and works
- **Accurate descriptions**: Be clear about what tools the MCP provides
- **Proper categorization**: Use existing categories when possible
- **No secrets**: Never include API keys, tokens, or credentials in entries
- **Stable URLs**: Only submit MCPs with stable, production endpoints

## Categories

Current categories (as recognized by automation):
- AI & Reasoning
- Automation & Integration
- Browser & Automation
- Cloud & Infrastructure
- Commerce & Payments
- Communication
- Creative
- Data & Web Scraping
- Database & Backend
- Design
- Developer Tools
- DevOps & Monitoring
- Finance & Data
- Game Development
- Maps & Location
- Productivity
- Project Management
- Search & Web
- Utilities
- Visualization

Propose new categories in your PR if none fit.

## Validation

The CI pipeline validates:
- YAML syntax
- Required fields present
- Unique MCP names
- Valid transport and auth types
- URL format validation

## What to Expect from Automation

When you open an issue:
- Labels added automatically based on keywords (mcp-request, registry-issue, security)
- needs-triage label added

When you open a PR modifying registry.yaml:
- First-time contributors receive a welcome message with a submission checklist
- Automated validation runs and posts a summary comment (schema check, duplicate check, security patterns)
- Category, transport type, and auth type labels are auto-added based on your entry
- PRs inactive for 14+ days marked stale; 21+ days auto-closed

## Reporting Issues

- **Broken or outdated entry**: Use the "Registry Issue" template
- **Request a new MCP**: Use the "MCP Request" template
- **Malicious entry**: Report privately via .github/SECURITY.md

## AI-Assisted Contributions

We welcome AI-assisted contributions. This repo includes .github/copilot-instructions.md with rules that AI tools follow. AI tools can help generate properly formatted YAML entries.

## Getting Help

Open an issue with your question, or check the [MCP Ambassador documentation](https://mcpambassador.ai).

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

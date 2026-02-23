# Contributing to MCP Ambassador Community Registry

Thank you for helping grow the MCP ecosystem!

## Adding a New MCP

1. Fork this repository
2. Edit `registry.yaml` and add your MCP entry
3. Run validation: `npm run validate` (or check CI)
4. Submit a pull request

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

Current categories:
- Developer Tools
- Finance & Data
- Search & Web
- Productivity
- Utilities

Propose new categories in your PR if none fit.

## Validation

The CI pipeline validates:
- YAML syntax
- Required fields present
- Unique MCP names
- Valid transport and auth types
- URL format validation

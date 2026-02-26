# MCP Ambassador Community Registry — Copilot Instructions

## Repo Context

This is the **community-registry** repository — a community-maintained YAML registry of MCP servers that can be used with MCP Ambassador. This repo receives high PR volume from community contributors.

**Contents:**
- `registry.yaml` — the authoritative registry file; all MCP entries live here
- `schema/registry.schema.json` — JSON Schema (draft-07) defining valid registry entries
- `CONTRIBUTING.md` — contributor guide

## Registry Schema (Key Fields)

Every MCP entry in `registry.yaml` must conform to the JSON Schema at `schema/registry.schema.json`. Here are the key fields:

### Required Fields
```yaml
- name: "unique-lowercase-slug"        # pattern: ^[a-z0-9][a-z0-9-]*$
  display_name: "Human Readable Name"
  description: "What this MCP does"
  transport_type: http | stdio
  config:
    url: "https://..."                  # for http transport
    command: ["npx", "-y", "package"]   # for stdio transport
  auth_type: none | static | oauth2
```

### Optional but Strongly Recommended
```yaml
  icon_url: "https://..."
  isolation_mode: shared | per_user    # default: per_user
  requires_user_credentials: false
  tags: ["category", "tag"]
  category: "Developer Tools"          # see canonical categories below
  repository_url: "https://github.com/..."
  documentation_url: "https://..."
  version: "1.0.0"
  maintainer: "Author or Org Name"
  verified: false
```

### Canonical Categories
Use one of these values for `category`:
- `Developer Tools`
- `Productivity`
- `Data & Analytics`
- `Communication`
- `AI & ML`
- `Security`
- `Infrastructure`
- `Finance`
- `Media & Entertainment`
- `Education`
- `E-commerce`
- `Other`

## Review Criteria for Registry PRs

When reviewing a PR that adds or modifies a registry entry:

### BLOCKING issues (must be fixed before merge)
1. `name` field does not match pattern `^[a-z0-9][a-z0-9-]*$`
2. `transport_type: stdio` with `config.command` that runs arbitrary code risk (e.g. `bash -c "$(curl ..."`)
3. `config.url` pointing to a non-HTTPS URL (all MCP endpoints should use TLS)
4. Duplicate `name` — must be unique across all entries
5. oauth2 auth_type without `oauth_config` block
6. Missing required fields (schema validation catches these)

### WARNINGS (flag but can merge)
1. Missing `icon_url`
2. Missing `repository_url` or `documentation_url`
3. `verified: true` set by a non-maintainer (only maintainers set this)
4. No `tags`
5. `version` field missing

### NEVER approve
- Entries pointing to domains that appear to be typosquats of popular services
- Entries with `config.command` that pipe to shell or use curl/wget to fetch code at runtime
- Entries with `config.url` pointing to localhost or private IP ranges

## YAML Style
- 2-space indentation
- Entries sorted alphabetically by `name` within the `mcps:` array
- Strings with special characters should use double quotes
- No trailing whitespace

## Security Mindset
This registry is a trust artifact — users add MCPs from this registry to their servers. A malicious entry could compromise users. Apply the same skepticism you would to an npm package being added to a production system.

When in doubt, ask: "If a user added this to their MCP Ambassador server, could it exfiltrate their credentials, execute arbitrary code, or phone home?"

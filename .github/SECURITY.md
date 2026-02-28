# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Current registry | Active |

## Reporting a Vulnerability

Please do NOT report security vulnerabilities as public GitHub issues.

We use GitHub's private security advisory feature:
1. Go to [Security Advisories](https://github.com/mcpambassador/community-registry/security/advisories/new)
2. Click "Report a vulnerability"
3. Fill in the details

Alternatively, email: security@mcpambassador.dev

### What Qualifies as a Security Issue

- Malicious MCP entries (exfiltrating credentials, executing unauthorized code)
- Entries with shell injection patterns in command fields
- Typosquatting domains mimicking legitimate MCP servers
- Entries pointing to compromised or malicious endpoints
- OAuth configurations designed to steal tokens

### Our Commitment

- Acknowledge within 48 hours
- Remove or disable malicious entries immediately upon confirmation
- Notify affected users if possible

### What Does NOT Qualify

- MCP servers that are temporarily offline
- Entries with incorrect but non-malicious metadata
- Feature disagreements about categorization

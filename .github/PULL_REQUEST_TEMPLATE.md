## New MCP Submission

Thank you for contributing to the MCP Ambassador Community Registry!

Please complete this checklist before requesting a review.

---

### MCP Entry Summary

**MCP Name (the `name` field):** <!-- e.g. my-cool-mcp -->
**Display Name:** <!-- e.g. My Cool MCP -->
**Author/Maintainer:** <!-- Your name or org -->
**Repository:** <!-- Link to the MCP server's source repository -->

---

### Checklist

#### Required
- [ ] My entry passes the automated schema validation (green check on the "Validate Registry" workflow)
- [ ] The `name` field uses lowercase kebab-case (e.g. `my-cool-mcp`)
- [ ] The `name` is unique — it does not duplicate an existing registry entry
- [ ] All required fields are present: `name`, `display_name`, `description`, `transport_type`, `config`, `auth_type`
- [ ] If `auth_type: oauth2`, I have included a complete `oauth_config` block
- [ ] If `transport_type: http`, the `config.url` uses HTTPS (not HTTP)
- [ ] The `description` explains what the MCP does in 1–2 sentences

#### Strongly Recommended
- [ ] `repository_url` — link to source code
- [ ] `documentation_url` — link to usage documentation
- [ ] `category` — one of the canonical categories (see CONTRIBUTING.md)
- [ ] `tags` — at least 2–3 relevant tags
- [ ] `icon_url` — URL to an icon (SVG or PNG, publicly accessible)
- [ ] `version` — current version of the MCP server
- [ ] `maintainer` — name or GitHub org of the MCP maintainer
- [ ] `isolation_mode` — `shared` or `per_user` (see CONTRIBUTING.md for guidance)

#### Security Self-Assessment
- [ ] If `transport_type: stdio`, the `command` does not pipe to a shell or download code at runtime
- [ ] The MCP does not require credentials beyond what is documented in `credential_schema`
- [ ] I am the maintainer of this MCP server or have permission to submit it

---

### YAML Snippet

<!-- Paste the YAML entry you added here for quick review reference -->

```yaml
# Your entry:
```

---

### Additional Context

<!-- Any other information for reviewers: known limitations, planned features, etc. -->

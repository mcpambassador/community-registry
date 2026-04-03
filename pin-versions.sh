#!/usr/bin/env bash
# pin-versions.sh
# Pins all community registry npx entries to specific package versions.
# Handles four YAML list-item patterns:
#   1. - package-name@latest          (bare, @latest)
#   2. - 'package-name@latest'        (quoted, @latest — used for scoped pkgs)
#   3. - package-name                 (bare, no tag)
#   4. - '@scope/package-name'        (quoted, no tag — used for scoped pkgs)

set -euo pipefail

REGISTRY="/home/zervin/projects/mcpambassador/community-registry/registry.yaml"

echo "Pinning registry entries in: $REGISTRY"
echo ""

# ---------------------------------------------------------------------------
# Helper: pin one package.
# Usage: pin_package "package-name" "x.y.z"
# Handles all four YAML list-item patterns for that package name.
# ---------------------------------------------------------------------------
pin_package() {
  local pkg="$1"
  local ver="$2"

  # Pattern 1: unquoted bare  →  - package-name
  sed -i "s|^    - ${pkg}$|    - ${pkg}@${ver}|" "$REGISTRY"

  # Pattern 2: unquoted @latest  →  - package-name@latest
  sed -i "s|^    - ${pkg}@latest$|    - ${pkg}@${ver}|" "$REGISTRY"

  # Pattern 3: quoted bare  →  - 'package-name'
  sed -i "s|^    - '${pkg}'$|    - '${pkg}@${ver}'|" "$REGISTRY"

  # Pattern 4: quoted @latest  →  - 'package-name@latest'
  sed -i "s|^    - '${pkg}@latest'$|    - '${pkg}@${ver}'|" "$REGISTRY"
}

# ---------------------------------------------------------------------------
# Pin each package to its specific version.
# ---------------------------------------------------------------------------

pin_package "airtable-mcp-server"                          "1.13.0"
pin_package "arxiv-mcp-server"                             "0.1.5"
pin_package "mcp-atlassian"                                "2.1.0"
pin_package "@modelcontextprotocol/server-aws-kb-retrieval" "0.6.2"
pin_package "@brave/brave-search-mcp-server"               "2.0.75"
pin_package "@browserbasehq/mcp-server-browserbase"        "2.4.3"
pin_package "clickhouse-mcp"                               "0.1.1"
pin_package "@cloudflare/mcp-server-cloudflare"            "0.2.0"
pin_package "mcp-server-cockroachdb"                       "0.0.1"
pin_package "@upstash/context7-mcp"                        "2.1.6"
pin_package "docker-mcp-server"                            "2.1.1"
pin_package "duckduckgo-mcp"                               "1.0.1"
pin_package "mcp-server-elasticsearch"                     "0.2.0"
pin_package "mcp-server-elevenlabs"                        "0.0.1"
pin_package "@modelcontextprotocol/server-everart"         "0.6.2"
pin_package "exa-mcp-server"                               "3.2.0"
pin_package "figma-mcp-server"                             "2.1.1"
pin_package "@modelcontextprotocol/server-filesystem"      "2026.1.14"
pin_package "firecrawl-mcp"                                "3.11.0"
pin_package "firewalla-mcp-server"                         "1.2.2"
pin_package "@modelcontextprotocol/server-gitlab"          "2025.4.25"
pin_package "kubernetes-mcp-server"                        "0.0.60"
pin_package "linear-mcp-server"                            "0.1.0"
pin_package "@modelcontextprotocol/server-memory"          "2026.1.26"
pin_package "metabase-mcp-server"                          "1.0.2"
pin_package "@mondaydotcomorg/monday-api-mcp"              "3.0.0"
pin_package "mongodb-mcp-server"                           "1.9.0"
pin_package "n8n-mcp"                                      "2.46.1"
pin_package "@notionhq/notion-mcp-server"                  "2.2.1"
pin_package "openapi-mcp-server"                           "2.1.0"
pin_package "openweather-mcp"                              "1.0.0"
pin_package "oracle-mcp"                                   "1.0.1"
pin_package "@playwright/mcp"                              "0.0.70"
pin_package "pluggedin-mcp-proxy"                          "0.4.8"
pin_package "@modelcontextprotocol/server-postgres"        "0.6.2"
pin_package "postman-mcp-server"                           "1.2.0"
pin_package "prometheus-mcp"                               "1.1.3"
pin_package "@pulumi/mcp-server"                           "0.2.0"
pin_package "@modelcontextprotocol/server-puppeteer"       "2025.5.12"
pin_package "@modelcontextprotocol/server-redis"           "2025.4.25"
pin_package "ref-tools-mcp"                                "3.0.3"
pin_package "mcp-server-render"                            "0.0.1"
pin_package "@sentry/mcp-server"                           "0.31.0"
pin_package "sequa-mcp"                                    "1.0.0"
pin_package "@modelcontextprotocol/server-sequential-thinking" "2025.12.18"
pin_package "@modelcontextprotocol/server-slack"           "2025.4.25"
pin_package "sonarqube-mcp-server"                         "1.10.21"
pin_package "@stripe/mcp"                                  "0.3.3"
pin_package "tavily-mcp"                                   "0.2.18"
pin_package "todoist-mcp-server"                           "1.0.7"
pin_package "@modelcontextprotocol/server-google-maps"     "0.6.2"

echo "Done. Packages left unpinned (not on npm — left as-is):"
echo "  @grafana/mcp-server"
echo "  lara-mcp"
echo "  @modelcontextprotocol/server-time"
echo ""

PINNED=$(grep -c '@[0-9]' "$REGISTRY" || true)
echo "Pinned version entries in registry.yaml: $PINNED"

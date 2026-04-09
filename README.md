# unimcp

[![CI](https://github.com/dandehoon/unimcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dandehoon/unimcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dandehoon/unimcp)](https://www.npmjs.com/package/@dandehoon/unimcp)

One MCP endpoint for all your servers.

Instead of registering Context7, Searxng, your internal API, and a dozen others separately in every editor, configure them once and point every editor at unimcp. All tools are merged under a single endpoint — prefixed as `serverName__toolName` to avoid collisions.

## Quick start

```bash
# Register in your editors (creates config if missing)
npx @dandehoon/unimcp setup

# Add your first server
npx @dandehoon/unimcp add context7 --type http --url https://mcp.context7.com/mcp
```

That's it. Restart your editor and all `context7__*` tools are available.

## Cheatsheet

```bash
# Manage servers
unimcp list                             # show all servers
unimcp get context7                     # inspect one server
unimcp add context7 --type http --url https://mcp.context7.com/mcp
unimcp add searxng --command docker --args "run,-i,--rm,dandehoon/searxng-mcp:edge"
unimcp add-json my-api '{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}'
unimcp remove searxng                   # remove a server

# Setup
unimcp setup                            # register in editors (local, project-level)
unimcp setup --global                   # register globally
unimcp setup --global --target claude,copilot

# Inspect
unimcp status                           # show daemon status and loaded tools

# Import from editors
unimcp collect                          # print merged config from all installed editors
unimcp collect --save                   # write to ~/.config/unimcp/mcp.json
```

Config changes hot-reload — no restart needed.

## Configuration

Default config: `~/.config/unimcp/mcp.json`. Override with `--mcp-file` or `UNIMCP_CONFIG`.

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    },
    "searxng": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "dandehoon/searxng-mcp:edge"]
    },
    "my-api": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  }
}
```

`${VAR}` references are expanded from the process environment at load time. Set secrets in your shell profile — `.env` files are not auto-loaded.

### Per-client tool filtering

Control which tools each editor sees:

```json
{
  "mcpServers": { ... },
  "clients": {
    "claude":   { "tools": { "exclude": ["searxng__*"] } },
    "copilot":  { "tools": { "exclude": ["searxng__*", "fetch__*"] } },
    "opencode": { "tools": { "include": ["*"] } }
  }
}
```

`unimcp setup` injects `UNIMCP_CLIENT` into each editor's registration automatically.

| Editor | Client name |
|--------|-------------|
| Claude Code | `claude` |
| Cursor | `cursor` |
| VS Code / GitHub Copilot | `copilot` |
| OpenCode | `opencode` |

## Setup

Writes the registration entry into your editor config. Re-running is safe — already-registered targets are skipped.

| Target | Local (cwd) | Global |
|--------|-------------|--------|
| `claude` | `.mcp.json` | `~/.claude.json` |
| `cursor` | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| `copilot` | `.vscode/mcp.json` | `~/Library/Application Support/Code/User/mcp.json` |
| `opencode` | _(none)_ | `~/.config/opencode/opencode.json` |

## Install

```bash
npm install -g @dandehoon/unimcp
```

Or run without installing:

```bash
npx @dandehoon/unimcp setup
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNIMCP_PORT` | `4848` | HTTP server preferred port |
| `UNIMCP_HOST` | `127.0.0.1` | HTTP server bind address |
| `UNIMCP_CONFIG` | `~/.config/unimcp/mcp.json` | Config file path |
| `UNIMCP_CLIENT` | _(unset)_ | Client identity for per-client tool filtering |

## Development

```bash
pnpm dev             # stdio mode (bun, no compile)
pnpm typecheck       # tsc --noEmit
pnpm test            # bun test
pnpm bundle          # build dist/unimcp.js (Node.js bundle)
pnpm install-bin     # compile + install to /usr/local/bin/unimcp
```

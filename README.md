# unimcp

[![CI](https://github.com/dandehoon/unimcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dandehoon/unimcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dandehoon/unimcp)](https://www.npmjs.com/package/@dandehoon/unimcp)

A local MCP aggregator that connects to multiple MCP servers and exposes all their tools through a **single unified endpoint**.

Tool names are prefixed as `serverName__toolName` (e.g. `context7__resolve-library-id`).

## Install

### Via npm (requires [bun](https://bun.sh))

```bash
npm install -g @dandehoon/unimcp
# or
pnpm add -g @dandehoon/unimcp
```

### Build from source

Requires [bun](https://bun.sh) and [pnpm](https://pnpm.io):

```bash
git clone https://github.com/dandehoon/unimcp
cd unimcp
pnpm install && pnpm install-bin    # → /usr/local/bin/unimcp
```

## Setup

After installing, register unimcp in your editors.

### Local (project-level) — default

Writes to `.cursor/mcp.json` and `.vscode/mcp.json` in the current directory:

```bash
unimcp setup
# or: pnpm register
```

### Global (user-level)

Updates existing global editor configs. Only updates configs for editors that already have a config file; use `--target` to force-create:

```bash
unimcp setup --global
unimcp setup --global --target claude,copilot   # force-write even if file doesn't exist
```

Supported targets and their global config paths:

| Target | Config file |
|--------|-------------|
| `claude` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| `cursor` | `~/.cursor/mcp.json` |
| `copilot` | `~/Library/Application Support/Code/User/mcp.json` |
| `opencode` | `~/.config/opencode/opencode.json` |

> Re-running `setup` is safe — already-registered targets are skipped (dedup).

## Configuration

Create an `mcp.json` anywhere (default: `mcp.json` in cwd, or set `CONFIG=/path/to/mcp.json`):

```jsonc
{
  "mcpServers": {
    // HTTP server
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    },
    // stdio server (e.g. via Docker)
    "searxng": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "dandehoon/searxng-mcp:edge"]
    },
    // HTTP server with auth header (env vars expanded via ${VAR})
    "my-api": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    },
    // Limit which tools are exposed (glob patterns)
    "big-server": {
      "type": "http",
      "url": "https://big.example.com/mcp",
      "tools": { "include": ["search-*"], "exclude": ["search-internal"] }
    }
  }
}
```

Secrets go in `.env` next to `mcp.json` (or set them in your shell environment):

```bash
MY_TOKEN=your-token-here
```

## Modes

### stdio — default

Auto-starts a shared daemon, then bridges stdin/stdout through it. The daemon is reused across all client connections — upstream processes start only once.

```bash
unimcp               # or: pnpm dev
```

### HTTP daemon — `--http`

Runs the HTTP server directly. Features:
- **Session tracking** — auto-stops 30 s after the last client disconnects
- **Hot reload** — watches `mcp.json` and reconnects upstreams on change
- **Health check** — `GET /health` returns `200 ok`
- **Auto port fallback** — tries port 4848; falls back to an OS-assigned port if in use

```bash
unimcp --http        # or: pnpm http
```

## Development

```bash
pnpm dev             # run with bun (no compile step)
pnpm typecheck       # tsc --noEmit
pnpm build           # compile → dist/unimcp
pnpm install-bin     # build + install to /usr/local/bin/unimcp
```

## Environment variables

| Variable | Default     | Description                  |
| -------- | ----------- | ---------------------------- |
| `PORT`   | `4848`      | HTTP server preferred port   |
| `HOST`   | `127.0.0.1` | HTTP server bind address     |
| `CONFIG` | `mcp.json`  | Path to server config file   |

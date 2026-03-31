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

Then register yourself with your editors:

```bash
unimcp setup
```

### Pre-built binary

Download from [GitHub Releases](https://github.com/dandehoon/unimcp/releases) — no runtime required:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/dandehoon/unimcp/releases/latest/download/unimcp-macos-arm64 -o /usr/local/bin/unimcp
chmod +x /usr/local/bin/unimcp
codesign --force --deep --sign - /usr/local/bin/unimcp

# macOS (Intel)
curl -L https://github.com/dandehoon/unimcp/releases/latest/download/unimcp-macos-x64 -o /usr/local/bin/unimcp
chmod +x /usr/local/bin/unimcp
codesign --force --deep --sign - /usr/local/bin/unimcp

# Linux x64
curl -L https://github.com/dandehoon/unimcp/releases/latest/download/unimcp-linux-x64 -o /usr/local/bin/unimcp
chmod +x /usr/local/bin/unimcp
```

### Build from source (requires [bun](https://bun.sh) + [pnpm](https://pnpm.io))

```bash
pnpm install && pnpm install-bin    # → /usr/local/bin/unimcp
```

## Setup

After installing, register unimcp in all detected editors:

```bash
unimcp setup
# or: pnpm register
```

Supported targets — auto-detected from installed applications:

| Editor | Config file |
|--------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code / GitHub Copilot | `~/Library/Application Support/Code/User/mcp.json` |
| OpenCode | `~/.config/opencode/opencode.json` |

Options:
```bash
unimcp setup --target claude,copilot   # register only specific targets
```

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

Client config:

```json
{
  "unimcp": {
    "type": "http",
    "url": "http://127.0.0.1:4848/mcp"
  }
}
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

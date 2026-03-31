# unimcp

A local MCP aggregator that connects to multiple MCP servers and exposes all their tools through a **single unified endpoint**.

Tool names are prefixed as `serverName__toolName` (e.g. `context7__resolve-library-id`).

## Quick start

```bash
# Install binary (requires bun)
pnpm install && pnpm install-bin    # → /usr/local/bin/unimcp
```

Configure your MCP client (`mcp.json` is gitignored — create your own):

```json
{
  "unimcp": {
    "type": "stdio",
    "command": "unimcp",
    "env": { "CONFIG": "/path/to/your/mcp.json" }
  }
}
```

On first run, `unimcp` auto-starts a shared background daemon and bridges stdio through it. Upstream processes start **once** and are reused across all client connections.

## Configuration

Create an `mcp.json` (VS Code Copilot format):

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

## Build & install

Requires [Bun](https://bun.sh). Compiles a self-contained binary — no runtime needed on target machines.

```bash
pnpm install
pnpm build           # → dist/unimcp (59 MB, self-contained)
pnpm install-bin     # builds + copies to /usr/local/bin/unimcp
```

## Modes

### stdio — default

Auto-starts a shared daemon, then bridges stdin/stdout through it.

```bash
unimcp               # or: pnpm dev
```

### HTTP daemon — `--http`

Runs the HTTP server directly. Features:
- **Session tracking** — auto-stops 30 s after the last client disconnects  
- **Hot reload** — watches `mcp.json` and reconnects upstreams on change  
- **Health check** — `GET /health` returns `200 ok`

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
```

## Environment variables

| Variable | Default     | Description                  |
| -------- | ----------- | ---------------------------- |
| `PORT`   | `4848`      | HTTP server port              |
| `HOST`   | `127.0.0.1` | HTTP server bind address      |
| `CONFIG` | `mcp.json`  | Path to server config file    |

# unimcp

[![CI](https://github.com/dandehoon/unimcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dandehoon/unimcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dandehoon/unimcp)](https://www.npmjs.com/package/@dandehoon/unimcp)

One MCP endpoint for all your servers.

Instead of registering Context7, Searxng, your internal API, and a dozen others separately in every editor, you configure them once in `~/.config/unimcp/mcp.json` and point every editor at unimcp. It merges all tools under a single unified endpoint — tool names are prefixed as `serverName__toolName` (e.g. `context7__resolve-library-id`) so collisions are impossible.

## Quick start

```bash
# 1. Create a config
mkdir -p ~/.config/unimcp
cat > ~/.config/unimcp/mcp.json << 'EOF'
{
  "mcpServers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" }
  }
}
EOF

# 2. Register in your editors (run from your project directory)
npx @dandehoon/unimcp setup
```

That's it. Your editors will connect to unimcp as a single MCP server. Add more servers to `mcp.json` anytime — changes hot-reload without restarting anything.

If you use unimcp daily, install it globally to skip the `npx` prefix:

```bash
npm install -g @dandehoon/unimcp
# then use: unimcp setup, unimcp status, unimcp collect, ...
```

## Configuration

The default config file is `~/.config/unimcp/mcp.json`. Override with `--mcp-file` or the `UNIMCP_CONFIG` env var.

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
    },
    "big-server": {
      "type": "http",
      "url": "https://big.example.com/mcp",
      "tools": { "include": ["search-*"], "exclude": ["search-internal"] }
    }
  }
}
```

Secrets go in your shell environment (`.env` files are **not** auto-loaded):

```bash
export MY_TOKEN=your-token-here
```

Set these before launching unimcp or add them to your shell profile. `${VAR}` references in `mcp.json` are expanded from the process environment at load time.

### Per-client tool filtering

Use the `clients` section to control which tools each editor sees. Filters use the same glob patterns as per-server `tools` filters, applied on top of them:

```json
{
  "mcpServers": {
    "searxng": { "command": "docker", "args": ["run", "-i", "--rm", "dandehoon/searxng-mcp:edge"] },
    "fetch":   { "command": "fetch-mcp" },
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" }
  },
  "clients": {
    "claude":   { "tools": { "exclude": ["searxng__*"] } },
    "copilot":  { "tools": { "exclude": ["searxng__*", "fetch__*"] } },
    "opencode": { "tools": { "include": ["*"] } }
  }
}
```

Client identity is determined by the `UNIMCP_CLIENT` env var, which `unimcp setup` injects automatically into each editor's registration:

| Editor | Client name |
|--------|-------------|
| Claude Code | `claude` |
| Cursor | `cursor` |
| VS Code / GitHub Copilot | `copilot` |
| OpenCode | `opencode` |

Editors without a matching `clients` entry see all tools (open default).

## Setup

`unimcp setup` writes the registration entry into your editor config files. Re-running is safe — already-registered targets are skipped.

### Local (project-level) — default

Writes to `.mcp.json` (claude), `.cursor/mcp.json` (cursor), and `.vscode/mcp.json` (copilot) in the current directory:

```bash
unimcp setup
```

### Global (user-level)

Updates existing global editor configs. Only updates configs for editors that already have a config file; use `--target` to force-create:

```bash
unimcp setup --global
unimcp setup --global --target claude,copilot   # force-write even if file doesn't exist
```

Supported targets:

| Target | Local path (cwd) | Global path |
|--------|-----------------|-------------|
| `claude` | `.mcp.json` | `~/.claude.json` |
| `cursor` | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| `copilot` | `.vscode/mcp.json` | `~/Library/Application Support/Code/User/mcp.json` |
| `opencode` | _(none)_ | `~/.config/opencode/opencode.json` |

## Collect

Import MCP server configs from all installed editors into your unimcp config:

```bash
unimcp collect                        # print merged config to stdout
unimcp collect -o out.json            # write to a file
unimcp collect --save                 # write to ~/.config/unimcp/mcp.json
unimcp collect --save --mcp-file /path/to/mcp.json  # write to a custom file
```

Sources read: Claude Code (user scope `~/.claude.json`), Claude Code (project `.mcp.json`), Cursor global, VS Code/Copilot global, OpenCode global.

## Modes

### stdio — default

Auto-starts a shared daemon, then bridges stdin/stdout through it. The daemon is reused across all client connections — upstream processes start only once.

```bash
unimcp
```

### HTTP daemon — `--http`

Runs the HTTP server directly. Features:
- **Session tracking** — auto-stops 30 s after the last client disconnects
- **Hot reload** — watches `mcp.json` and reconnects upstreams on change
- **Health check** — `GET /health` returns `200 ok`
- **Auto port fallback** — tries port 4848; falls back to an OS-assigned port if in use

```bash
unimcp --http
```

## Commands

```
unimcp [command] [flags]

Commands:
  (default)          Stdio mode — ensures daemon, bridges stdio <-> HTTP
  --http             Managed HTTP server (daemon mode)
  --daemon           Alias for --http
  status             Show running daemon info and loaded tools
  setup              Register unimcp in editor configs
  collect            Merge editor MCP configs and print to stdout
  list               List all servers in mcp.json
  get <name>         Show details for one server
  add <name>         Add a server (--command/--url, --type, --args, --env, --header)
  add-json <name>    Add a server from a JSON string
  remove <name>      Remove a server
  help, --help       Show this message

Flags:
  --mcp-file <path>   Config file (default: ~/.config/unimcp/mcp.json)
  --global            (setup) Write to user-level editor config files
  --target <ids>      (setup) Comma-separated: claude,cursor,copilot,opencode
  -o <path>           (collect) Write output to a file
  --save              (collect) Write to --mcp-file path
```

## Install

```bash
npm install -g @dandehoon/unimcp
# or: pnpm add -g @dandehoon/unimcp
```

Or run without installing:

```bash
npx @dandehoon/unimcp setup
```

To build from source, see [Development](#development).

## Environment variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `UNIMCP_PORT`   | `4848`      | HTTP server preferred port (also accepts legacy `PORT`)   |
| `UNIMCP_HOST`   | `127.0.0.1` | HTTP server bind address (also accepts legacy `HOST`)     |
| `UNIMCP_CONFIG` | `~/.config/unimcp/mcp.json` | Path to server config file — overridden by `--mcp-file` (also accepts legacy `CONFIG`) |
| `UNIMCP_CLIENT` | _(unset)_ | Client identity sent to daemon as `X-Client-Name` header; used to apply per-client tool filters from the `clients` config section. Set automatically by `unimcp setup`. |

## Development

```bash
pnpm dev             # run with bun (no compile step)
pnpm typecheck       # tsc --noEmit
pnpm test            # bun test tests/
pnpm collect         # print merged MCP config from all editors to stdout
pnpm build           # compile → dist/unimcp
pnpm install-bin     # build + install to /usr/local/bin/unimcp
```

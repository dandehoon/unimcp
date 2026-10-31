# unimcp

A local MCP aggregator: define every MCP server once, and every client (Claude Code, Cursor, VS Code, OpenCode, …) reaches them through one shared daemon.

- **One config** in the standard `mcpServers` format — an existing client config works as-is.
- **One daemon** owns the upstream connections: it starts on first use, hot-reloads the config, and exits 30 s after the last client leaves, taking its stdio servers and containers with it.
- **Per-client control**: each client filters the tools it sees, and unlocks gated tools with grants.

## Quick start

Requires Node `^22.23.4`, `^24.22.1` or `>=26.12.1`.

```bash
npm install -g @dandehoon/unimcp

unimcp collect --save    # import the servers your clients already have, or add them:
unimcp add context7 --type http --url https://mcp.context7.com/mcp
unimcp add github --command npx --args "-y,@modelcontextprotocol/server-github" --env GITHUB_TOKEN='${GITHUB_TOKEN}'

unimcp setup --global    # register unimcp with your clients (--target=claude,cursor,copilot,opencode)
unimcp                   # in a terminal: daemon status and tools
```

Each client spawns a thin stdio bridge; the bridges share one HTTP daemon (port 4848, or a free one) that serves upstream tools as `serverName__toolName`. A daemon serves one context — the config file, the unimcp version and the values of the `${VAR}`s it references — so different secrets get separate daemons.

## Configuration

`~/.config/unimcp/unimcp.json`, unless `--mcp-file`, `UNIMCP_CONFIG` or a `./unimcp.json` says otherwise. Comments are allowed.

```jsonc
{
  "mcpServers": {
    "context7": { "url": "https://mcp.context7.com/mcp" },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },          // skipped while GITHUB_TOKEN is unset
      "include": ["search_*", "get_*"]                         // or "exclude"
    },
    "api": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer $(pass show api-token)" },
      "pinArgs": { "workspace": "main" }                       // fixed on every call, hidden from clients
    },
    "experimental": { "command": "npx", "args": ["-y", "experimental-mcp"], "enabled": false }
  }
}
```

- `${VAR}` comes from the environment; a server that references an unset one is skipped.
- `$(command)` in `env`, `headers` or `oauth.clientSecret` runs when that server connects, so a secret is read only when used and a rotated one is picked up on reconnect. It never applies to `command` or `args`, which show in `ps`.
- A stdio server still starting after 30 s (a first `npx` install, say) is left to finish; its tools appear when it answers.

## Per-client control

Set these in the client's unimcp entry, e.g. `{ "command": "unimcp", "env": { "UNIMCP_EXCLUDE": "internal__*" } }`. Globs match `serverName__toolName`.

| Variable | Effect |
|----------|--------|
| `UNIMCP_INCLUDE` / `UNIMCP_EXCLUDE` | Only show / hide matching tools |
| `UNIMCP_GRANTS` | Comma-separated grants the client holds |
| `UNIMCP_GRANTS_FILE` | A file of grants, one per line, applied live |
| `UNIMCP_PORT` / `UNIMCP_HOST` | Daemon address (default `127.0.0.1:4848`) |

### Grants

A top-level `grants` map hides tools from clients that don't hold the grant:

```json
{ "grants": { "deploy-write": ["portal__create_*", "portal__update_*"] } }
```

Besides `UNIMCP_GRANTS` and `UNIMCP_GRANTS_FILE`, a client holds whatever `unimcp grant <pid>` gave its process — handy for granting a running agent mid-session; its tool list updates live. A rule `{ "tool": "<glob>", "args": { … } }` keeps the tool listed but refuses calls with exactly those arguments; a call that leaves them out or names the target another way is open, so keep credentials apart with profiles.

A grant written as `{ "server", "vars" }` is a **profile**: its own copy of a server, with the server's `{var}` placeholders filled in. Clients see the server's tools once, with a `profile` argument listing the profiles they hold:

```jsonc
{
  "mcpServers": {
    "mongo": { "command": "npx", "args": ["-y", "mongodb-mcp-server"], "env": { "MDB_MCP_CONNECTION_STRING": "{uri}" } }
  },
  "grants": {
    "prod": { "server": "mongo", "vars": { "uri": "$(pass show mongo/prod)" }, "description": "production" },
    "staging": { "server": "mongo", "vars": { "uri": "$(pass show mongo/staging)" } }
  }
}
```

Grants are a guardrail, not a security boundary: any local process can claim any grant. Keep tools that must never be reachable out of the config.

### OAuth

Mark a remote server `"auth": "oauth"`, then sign in once with `unimcp auth <name>`. Tokens live owner-only under `~/.config/unimcp/oauth/` and refresh automatically. A server without dynamic client registration needs `"oauth": { "clientId", "clientSecret", "scopes", "callbackPort" }`, with `http://localhost:<callbackPort>/callback` (default 4849) allowed as its redirect URL.

## Commands

```
unimcp                       Stdio bridge for a client; in a terminal, `status`
unimcp status                Running daemons and their tools
unimcp list | get <name>     Configured servers
unimcp add <name> …          Add a server (--command/--args/--env or --url/--header); add-json <name> <json>
unimcp remove <name>         Remove a server
unimcp collect [--save]      Merge the MCP configs of installed clients
unimcp setup [--global]      Register unimcp in client configs
unimcp auth <name>           Sign in to an OAuth server (<server>.<profile> for a profile)
unimcp grant <pid> [-- ±g…]  List, add (+g) or remove (-g) a client process's grants; --drop clears
unimcp restart [id|--all]    Stop a daemon; the next client respawns it
unimcp stop <id> | shutdown  Stop one daemon / all of them
unimcp completion            Print the zsh completion script
```

## Development

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm install-bin    # compiled binary in /usr/local/bin, plus zsh completion
```

## License

MIT

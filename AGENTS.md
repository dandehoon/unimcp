# AGENTS.md — unimcp

Coding agent reference for the **unimcp** repository: a TypeScript MCP aggregator that merges multiple upstream MCP servers into a single stdio/HTTP endpoint.

---

## Project layout

```
src/
  index.ts       # Entry point — routes to server, daemon, bridge, or setup mode
  config.ts      # Config types + loader with ${VAR} env expansion
  aggregator.ts  # Upstream client manager, tool merger, call router
  server.ts      # Managed HTTP server (session tracking, hot-reload, auto-stop)
  daemon.ts      # Background daemon lifecycle (pid file + health check)
  bridge.ts      # Stdio ↔ HTTP bridge (used in default stdio mode)
  setup.ts       # Editor registration (Claude Desktop, Cursor, VS Code, OpenCode)
bin/
  unimcp.js      # npm launcher: finds bun and runs src/index.ts
.github/
  workflows/
    ci.yml       # Type check on push/PR to main
    release.yml  # Build multi-platform binaries + publish to npm on vX.Y.Z tag
mcp.json         # Server config (gitignored — user-created, not committed)
.env             # Secrets (gitignored)
tsconfig.json    # Strict ESNext, moduleResolution: Bundler, noEmit
package.json     # pnpm project, scripts below
```

---

## Commands

```bash
# Development (no compile step — bun runs TS natively)
pnpm dev            # stdio mode: ensure daemon + bridge
pnpm http           # HTTP mode: managed server on :4848
pnpm daemon         # alias for --http (explicit daemon invocation)
pnpm register       # register unimcp in Claude Desktop, Copilot, OpenCode, Cursor

# Type checking (no tests exist yet)
pnpm typecheck      # tsc --noEmit — must pass before any commit

# Build & install compiled binary
pnpm build          # bun build --compile --minify → dist/unimcp
pnpm install-bin    # build + cp dist/unimcp /usr/local/bin/unimcp
```

There are no automated tests. The canonical verification step is:

1. `pnpm typecheck` — zero errors required
2. Manual smoke test: `printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | timeout 20 pnpm dev 2>/dev/null`

---

## TypeScript conventions

### Module system

- **ESM only** — `"type": "module"` in `package.json`
- All local imports use `.js` extension even for `.ts` source files:
  ```ts
  import { loadConfig } from './config.js'; // ✅
  import { loadConfig } from './config.ts'; // ❌
  import { loadConfig } from './config'; // ❌
  ```
- SDK imports use deep paths with `.js`:
  ```ts
  import { Client } from '@modelcontextprotocol/sdk/client/index.js';
  import type { Tool } from '@modelcontextprotocol/sdk/types.js';
  ```

### Import ordering

1. Node built-ins (`fs`, `http`, `child_process`, `path`)
2. Third-party packages (`chokidar`, `minimatch`, SDK)
3. Local files (`./config.js`, `./aggregator.js`)

Use `import type` for type-only imports.

### TypeScript strictness

- `strict: true` — no implicit any, strict null checks, etc.
- All function parameters and return types must be inferrable; explicit annotations where inference is insufficient
- Unused destructured variables prefixed with `_` (e.g., `{ upstreamName: _u, ...tool }`)
- Use `ReturnType<typeof X>` over manually duplicating types (e.g., `ReturnType<typeof setTimeout>`)

### Types and interfaces

- Use `type` aliases, not `interface`, for object shapes
- Export types with `export type`; never export bare `interface`
- Union types for discriminated variants: `type ServerConfig = StdioServer | HttpServer`
- Type guards via explicit functions: `function isHttpServer(s: ServerConfig): s is HttpServer`
- Options objects for functions with more than 2 parameters:
  ```ts
  // ✅
  export async function startManagedServer(
    opts: ManagedServerOptions,
  ): Promise<void>;
  // ❌
  export async function startManagedServer(
    port: number,
    host: string,
    configPath: string,
  );
  ```

---

## Code style

### File size

- Each file has a single clear responsibility
- Keep files under ~150 lines; extract helpers when approaching that limit

### Function design

- Functions do one thing; max ~50 lines
- Early return to reduce nesting — avoid deep if/else chains
- **Flow functions** only coordinate; zero domain logic
- **Worker functions** execute one task; never acquire a second responsibility
- Helper functions that are not part of a public API go below a `// --- helpers ---` comment at the bottom of the file

### Naming

- `camelCase` for variables, functions, parameters
- `PascalCase` for types and classes
- `SCREAMING_SNAKE_CASE` for module-level constants: `const IDLE_TIMEOUT_MS = 30_000`
- Prefix unused destructure bindings with `_`
- Boolean variables: `is*`, `has*`, `use*` prefixes

### Numeric literals

- Use `_` separators for readability: `30_000`, `3_000`

### Async/await

- Always `await` Promises; never fire-and-forget unless intentionally detached (daemon spawn)
- Concurrent independent work: `await Promise.all([...])`, not sequential awaits
- `.catch()` only at the top-level entry point (`main().catch(...)`)

---

## Error handling

- On error: **either return it or log it — never both, never omit**
- If the error breaks the flow → throw/return
- If the flow continues despite the error → `console.error(...)` and continue
- Upstream connection failures are non-fatal (logged, server skipped):
  ```ts
  } catch (err) {
    console.error(`[${name}] failed to connect:`, err);
  }
  ```
- MCP protocol errors are wrapped in `McpError`:
  ```ts
  throw new McpError(ErrorCode.InternalError, String(err));
  ```

---

## Logging

- **All logs go to `stderr`** (`console.error`) — stdout is reserved for MCP JSON-RPC messages
- Log prefix convention: `[moduleName]` e.g. `[server]`, `[daemon]`, `[bridge]`, `[context7]`
- Never use `console.log`

---

## MCP SDK patterns

### Server (per-request, stateless HTTP mode)

```ts
const server = new Server({ name, version }, { capabilities: { tools: {} } });
// capabilities: { tools: {} } MUST be set at construction for tools to work
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => { ... });
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);
await transport.handleRequest(req, res);
```

### Client (upstream)

```ts
const client = new Client({ name, version });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
);
// or
await client.connect(new StdioClientTransport({ command, args, env }));
```

### Tool naming

- Aggregated tools use `serverName__toolName` (double-underscore separator)
- The separator constant is `SEP = "__"` in `aggregator.ts`
- Parse with `indexOf(SEP)` + `slice`, not `split`, to handle tool names that also contain `__`

---

## Key architectural rules

- `mcp.json` is **gitignored** — never commit it; it is user-local
- `.env` is **gitignored** — secrets only; `${VAR}` in `mcp.json` is expanded at load time
- The daemon pid file lives at **`~/.config/unimcp/daemon.pid`** (not in cwd)
  - Format: `"<pid>:<port>"` e.g. `"94663:4848"` or `"94844:52341"` (after port fallback)
  - `CONFIG_DIR` and `PID_FILE` constants are exported from `server.ts`, imported by `daemon.ts`
  - Directory is created with `mkdirSync(..., { recursive: true })` before first write
- The daemon is a **shared background process** — `pnpm dev` bridges to it rather than spawning upstreams per client
- **Auto port fallback**: server tries `preferredPort` (default 4848); if `EADDRINUSE`, falls back to port 0 (OS-assigned); actual port written to pid file so bridge always discovers the right port
- `StreamableHTTPServerTransport` must be created **per request** (stateless: `sessionIdGenerator: undefined`)
- Upstream stdio servers inherit `{ ...process.env, ...srv.env }` — merge, not replace
- Reconnect on hot-reload: disconnect old aggregator before replacing with new one

---

## Setup / registration

`unimcp setup` (or `pnpm register`) registers the binary in all detected editor configs:

| Target            | Config file                                                       | Key          | Type value         |
| ----------------- | ----------------------------------------------------------------- | ------------ | ------------------ |
| Claude Desktop    | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | _(implicit stdio)_ |
| Cursor            | `~/.cursor/mcp.json`                                              | `mcpServers` | _(implicit stdio)_ |
| VS Code / Copilot | `~/Library/Application Support/Code/User/mcp.json`                | `servers`    | `"stdio"`          |
| OpenCode          | `~/.config/opencode/opencode.json`                                | `mcp`        | `"local"`          |

- **Dedup**: skips a target if `"unimcp"` key already exists
- **`--global`**: alias flag (all targets are global by nature)
- **`--target=claude,copilot`**: restrict to specific targets
- Cursor is registered only if `/Applications/Cursor.app` or `~/Applications/Cursor.app` is detected

---

## npm package

- **Package name**: `@dandehoon/unimcp` (scoped, public)
- **`bin`**: `./bin/unimcp.js` — thin Node.js launcher that finds `bun` and runs `src/index.ts`
- **`files`**: `src/`, `bin/`, `README.md` (no `dist/` — binaries are too large for npm)
- **`publishConfig`**: `{ "access": "public" }`
- Published to npmjs on `vX.Y.Z` tag push via GitHub Actions

### Release process

```bash
git tag vX.Y.Z && git push --tags
# → triggers release.yml:
#   1. typecheck
#   2. build 4 platform binaries (macos-arm64, macos-x64, linux-x64, linux-arm64)
#   3. create GitHub Release with all binaries attached
#   4. pnpm publish --no-git-checks → npmjs (uses NPM_TOKEN secret)
```

Required GitHub repository secrets:
- `NPM_TOKEN` — npmjs automation token with publish rights to `@dandehoon/unimcp`

---

## Before committing

```bash
pnpm typecheck   # must be clean (zero errors)
```

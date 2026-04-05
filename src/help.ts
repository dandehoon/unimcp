export function printHelp(): void {
  process.stdout.write(`Usage: unimcp [command] [flags]

Commands:
  (default)       Start in stdio mode — ensures daemon, then bridges stdio ↔ HTTP
  --http          Start as a managed HTTP server (daemon mode)
  status          Show running daemon info and loaded tools
  setup           Register unimcp in editor configs
  collect         Merge editor MCP configs and print to stdout
  help, --help    Show this message

Flags:
  --mcp-file <path>   Config file  (default: ~/.config/unimcp/mcp.json)
                      Also: UNIMCP_CONFIG env var
  --http              Run as HTTP server on port 4848
  --global            (setup) Write to user-level editor config files
  --target <ids>      (setup) Comma-separated: claude,cursor,copilot,opencode
  -o <path>           (collect) Write output to a file
  --save              (collect) Write to --mcp-file path

Config: --mcp-file flag > UNIMCP_CONFIG > ~/.config/unimcp/mcp.json\n`);
}

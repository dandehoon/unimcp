// A stdio MCP server for the aggregator's startup tests, run with bun.
//   --fail <msg>   print <msg> and $TOKEN to stderr, then exit 1 (an upstream dying on startup)
//   --gate <path>  serve only once <path> exists (an upstream slower than the start deadline); if
//                  it holds "fail", print that to stderr and exit 1 instead
import { existsSync, readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const fail = arg("--fail");
if (fail) {
  console.error(`${fail} ${process.env.TOKEN ?? ""}`);
  process.exit(1);
}

const gate = arg("--gate");
while (gate && !existsSync(gate)) await Bun.sleep(10);
if (gate && readFileSync(gate, "utf8") === "fail") {
  console.error("gave out mid-install");
  process.exit(1);
}

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool("ping", { description: "ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());

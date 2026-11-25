// A stdio MCP server for the aggregator's startup tests, run with bun.
//   --fail <msg>   print <msg> and $TOKEN to stderr, then exit 1 (an upstream dying on startup)
//   --gate <path>  serve only once <path> exists (an upstream slower than the start deadline); if
//                  it holds "fail", print that to stderr and exit 1 instead
//   --content      also serve a skill `demo`, a resource `note://readme` and a template `note://items/{id}`;
//                  $LABEL names this server in what it reads back
import { existsSync, readFileSync } from "fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

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
if (process.argv.includes("--content")) {
  const label = process.env.LABEL ?? "fixture";
  const skills = await SkillsExtension.load(memorySkillFiles({
    "demo/SKILL.md": `---\nname: demo\ndescription: A demo skill from ${label}\n---\nSee [the guide](references/GUIDE.md).\n`,
    "demo/references/GUIDE.md": `# Guide from ${label}\n`,
  }));
  skills.attach(server);
  server.registerResource("readme", "note://readme", {}, async (uri) => ({ contents: [{ uri: uri.href, text: `readme from ${label}` }] }));
  server.registerResource("item", new ResourceTemplate("note://items/{id}", { list: undefined }), {},
    async (uri, { id }) => ({ contents: [{ uri: uri.href, text: `item ${id} from ${label}` }] }));
}
await server.connect(new StdioServerTransport());

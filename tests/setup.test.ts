import { describe, test, expect } from "bun:test";
import {
  injectMcpServers,
  injectAntigravity,
  injectVsCodeServers,
  injectOpenCode,
  injectCodex,
} from "../src/setup-inject.js";

const BIN = "/usr/local/bin/unimcp";
const LAUNCH = { command: BIN, args: [] };

describe("injectMcpServers", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectMcpServers("", LAUNCH));
    expect(result.mcpServers.unimcp).toEqual({ type: "stdio", command: BIN, args: [] });
  });

  test("injects into existing config preserving other servers", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "other-bin" } } });
    const result = JSON.parse(injectMcpServers(existing, LAUNCH));
    expect(result.mcpServers.unimcp).toEqual({ type: "stdio", command: BIN, args: [] });
    expect(result.mcpServers.other).toEqual({ command: "other-bin" });
  });

  test("preserves unrelated top-level keys (e.g. ~/.claude.json projects field)", () => {
    const existing = JSON.stringify({ projects: { "/cwd": {} }, mcpServers: {} });
    const result = JSON.parse(injectMcpServers(existing, LAUNCH));
    expect(result.projects).toEqual({ "/cwd": {} });
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ mcpServers: { unimcp: { command: BIN } } });
    expect(injectMcpServers(existing, LAUNCH)).toBe(existing);
  });

  test("passes a runtime + script launch through as args", () => {
    const result = JSON.parse(injectMcpServers("", { command: "/usr/bin/node", args: ["/lib/unimcp.js"] }));
    expect(result.mcpServers.unimcp).toEqual({ type: "stdio", command: "/usr/bin/node", args: ["/lib/unimcp.js"] });
  });

  test("throws instead of overwriting a file it can't parse", () => {
    expect(() => injectMcpServers("{ not json", LAUNCH)).toThrow();
    expect(() => injectMcpServers("[]", LAUNCH)).toThrow();
    expect(() => injectMcpServers('{"mcpServers": []}', LAUNCH)).toThrow();
  });
});

describe("injectVsCodeServers", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectVsCodeServers("", LAUNCH));
    expect(result.servers.unimcp).toEqual({ type: "stdio", command: BIN, args: [] });
  });

  test("handles JSONC with comments and trailing commas", () => {
    const existing = '{\n  // a comment\n  "servers": {\n    "other": { "command": "x", },\n  },\n}';
    const result = JSON.parse(injectVsCodeServers(existing, LAUNCH));
    expect(result.servers.unimcp).toBeDefined();
    expect(result.servers.other).toEqual({ command: "x" });
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = '{ "servers": { "unimcp": { "command": "x" }, }, }';
    expect(injectVsCodeServers(existing, LAUNCH)).toBe(existing);
  });
});

describe("injectOpenCode", () => {
  test("injects the v2 shape into empty config", () => {
    const result = JSON.parse(injectOpenCode("", { command: BIN, args: ["a"] }));
    expect(result.mcp.servers.unimcp).toEqual({ type: "local", command: [BIN, "a"] });
  });

  test("preserves other keys and v2 servers", () => {
    const existing = JSON.stringify({ autoupdate: true, mcp: { servers: { other: { type: "local", command: ["x"] } } } });
    const result = JSON.parse(injectOpenCode(existing, LAUNCH));
    expect(result.autoupdate).toBe(true);
    expect(result.mcp.servers.other).toBeDefined();
    expect(result.mcp.servers.unimcp).toBeDefined();
  });

  test("dedup: v2 and pre-v2 entries both count as registered", () => {
    const v2 = JSON.stringify({ mcp: { servers: { unimcp: { type: "local", command: [BIN] } } } });
    const legacy = JSON.stringify({ mcp: { unimcp: { type: "local", command: [BIN], enabled: true } } });
    expect(injectOpenCode(v2, LAUNCH)).toBe(v2);
    expect(injectOpenCode(legacy, LAUNCH)).toBe(legacy);
  });
});

describe("injectAntigravity", () => {
  test("injects without a type field", () => {
    const result = JSON.parse(injectAntigravity("", LAUNCH));
    expect(result.mcpServers.unimcp).toEqual({ command: BIN, args: [] });
  });
});

describe("injectCodex", () => {
  test("creates the table in an empty file", () => {
    expect(injectCodex("", LAUNCH)).toBe(`[mcp_servers.unimcp]\ncommand = "${BIN}"\nargs = []\n`);
  });

  test("appends after existing content, leaving it untouched", () => {
    const existing = '# keep me\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "o"\n';
    const result = injectCodex(existing, { command: 'C:\\a "b"', args: ["x"] });
    expect(result.startsWith(existing)).toBe(true);
    expect(result.slice(existing.length)).toBe('\n[mcp_servers.unimcp]\ncommand = "C:\\\\a \\"b\\""\nargs = ["x"]\n');
  });

  test("dedup: bare or quoted table name", () => {
    for (const existing of ['[mcp_servers.unimcp]\ncommand = "x"\n', '[ mcp_servers."unimcp" ]\ncommand = "x"\n']) {
      expect(injectCodex(existing, LAUNCH)).toBe(existing);
    }
  });

  test("a sub-table of another server is not a match", () => {
    const existing = '[mcp_servers.unimcp-old]\ncommand = "x"\n';
    expect(injectCodex(existing, LAUNCH)).not.toBe(existing);
  });
});

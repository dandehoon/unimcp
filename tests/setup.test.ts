import { describe, test, expect } from "bun:test";
import {
  injectMcpServers,
  injectVsCodeServers,
  injectOpenCode,
} from "../src/setup.js";

const BIN = "/usr/local/bin/unimcp";
const CLIENT = "claude";

describe("injectMcpServers", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectMcpServers("", BIN, CLIENT));
    expect(result.mcpServers.unimcp).toEqual({ command: BIN, env: { UNIMCP_CLIENT: CLIENT } });
  });

  test("injects into existing config preserving other servers", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "other-bin" } } });
    const result = JSON.parse(injectMcpServers(existing, BIN, CLIENT));
    expect(result.mcpServers.unimcp).toEqual({ command: BIN, env: { UNIMCP_CLIENT: CLIENT } });
    expect(result.mcpServers.other).toEqual({ command: "other-bin" });
  });

  test("preserves unrelated top-level keys (e.g. ~/.claude.json projects field)", () => {
    const existing = JSON.stringify({ projects: { "/cwd": {} }, mcpServers: {} });
    const result = JSON.parse(injectMcpServers(existing, BIN, CLIENT));
    expect(result.projects).toEqual({ "/cwd": {} });
    expect(result.mcpServers.unimcp).toEqual({ command: BIN, env: { UNIMCP_CLIENT: CLIENT } });
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ mcpServers: { unimcp: { command: BIN, env: { UNIMCP_CLIENT: CLIENT } } } });
    expect(injectMcpServers(existing, BIN, CLIENT)).toBe(existing);
  });
});

describe("injectVsCodeServers", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectVsCodeServers("", BIN, "copilot"));
    expect(result.servers.unimcp).toEqual({ type: "stdio", command: BIN, args: [], env: { UNIMCP_CLIENT: "copilot" } });
    expect(result.inputs).toEqual([]);
  });

  test("injects into existing VS Code config", () => {
    const existing = JSON.stringify({ servers: { other: { type: "stdio", command: "other" } }, inputs: [] });
    const result = JSON.parse(injectVsCodeServers(existing, BIN, "copilot"));
    expect(result.servers.unimcp).toEqual({ type: "stdio", command: BIN, args: [], env: { UNIMCP_CLIENT: "copilot" } });
    expect(result.servers.other).toBeDefined();
  });

  test("handles JSONC with // comments", () => {
    const existing = '{\n  // a comment\n  "servers": {}\n}';
    const result = JSON.parse(injectVsCodeServers(existing, BIN, "copilot"));
    expect(result.servers.unimcp).toBeDefined();
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ servers: { unimcp: { type: "stdio", command: BIN, args: [], env: { UNIMCP_CLIENT: "copilot" } } } });
    expect(injectVsCodeServers(existing, BIN, "copilot")).toBe(existing);
  });
});

describe("injectOpenCode", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectOpenCode("", BIN, "opencode"));
    expect(result.mcp.unimcp).toEqual({ type: "local", command: [BIN], enabled: true, env: { UNIMCP_CLIENT: "opencode" } });
  });

  test("injects into existing opencode.json preserving other keys", () => {
    const existing = JSON.stringify({ autoupdate: true, mcp: {} });
    const result = JSON.parse(injectOpenCode(existing, BIN, "opencode"));
    expect(result.mcp.unimcp).toEqual({ type: "local", command: [BIN], enabled: true, env: { UNIMCP_CLIENT: "opencode" } });
    expect(result.autoupdate).toBe(true);
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ mcp: { unimcp: { type: "local", command: [BIN], enabled: true, env: { UNIMCP_CLIENT: "opencode" } } } });
    expect(injectOpenCode(existing, BIN, "opencode")).toBe(existing);
  });
});

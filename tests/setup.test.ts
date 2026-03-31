import { describe, test, expect } from "bun:test";
import {
  injectMcpServers,
  injectClaudeCodeGlobal,
  injectVsCodeServers,
  injectOpenCode,
} from "../src/setup.js";

const BIN = "/usr/local/bin/unimcp";

describe("injectMcpServers", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectMcpServers("", BIN));
    expect(result.mcpServers.unimcp).toEqual({ command: BIN });
  });

  test("injects into existing config preserving other servers", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "other-bin" } } });
    const result = JSON.parse(injectMcpServers(existing, BIN));
    expect(result.mcpServers.unimcp).toEqual({ command: BIN });
    expect(result.mcpServers.other).toEqual({ command: "other-bin" });
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ mcpServers: { unimcp: { command: BIN } } });
    expect(injectMcpServers(existing, BIN)).toBe(existing);
  });
});

describe("injectClaudeCodeGlobal", () => {
  test("injects into empty ~/.claude.json", () => {
    const result = JSON.parse(injectClaudeCodeGlobal("", BIN));
    expect(result.mcpServers.unimcp).toEqual({ command: BIN });
  });

  test("preserves other top-level keys (projects, settings, etc.)", () => {
    const existing = JSON.stringify({ projects: { "/cwd": {} }, mcpServers: {} });
    const result = JSON.parse(injectClaudeCodeGlobal(existing, BIN));
    expect(result.projects).toEqual({ "/cwd": {} });
    expect(result.mcpServers.unimcp).toEqual({ command: BIN });
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ mcpServers: { unimcp: { command: BIN } } });
    expect(injectClaudeCodeGlobal(existing, BIN)).toBe(existing);
  });
});

describe("injectVsCodeServers", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectVsCodeServers("", BIN));
    expect(result.servers.unimcp).toEqual({ type: "stdio", command: BIN, args: [] });
    expect(result.inputs).toEqual([]);
  });

  test("injects into existing VS Code config", () => {
    const existing = JSON.stringify({ servers: { other: { type: "stdio", command: "other" } }, inputs: [] });
    const result = JSON.parse(injectVsCodeServers(existing, BIN));
    expect(result.servers.unimcp).toEqual({ type: "stdio", command: BIN, args: [] });
    expect(result.servers.other).toBeDefined();
  });

  test("handles JSONC with // comments", () => {
    const existing = '{\n  // a comment\n  "servers": {}\n}';
    const result = JSON.parse(injectVsCodeServers(existing, BIN));
    expect(result.servers.unimcp).toBeDefined();
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ servers: { unimcp: { type: "stdio", command: BIN, args: [] } } });
    expect(injectVsCodeServers(existing, BIN)).toBe(existing);
  });
});

describe("injectOpenCode", () => {
  test("injects into empty config", () => {
    const result = JSON.parse(injectOpenCode("", BIN));
    expect(result.mcp.unimcp).toEqual({ type: "local", command: [BIN], enabled: true });
  });

  test("injects into existing opencode.json preserving other keys", () => {
    const existing = JSON.stringify({ autoupdate: true, mcp: {} });
    const result = JSON.parse(injectOpenCode(existing, BIN));
    expect(result.mcp.unimcp).toEqual({ type: "local", command: [BIN], enabled: true });
    expect(result.autoupdate).toBe(true);
  });

  test("dedup: returns unchanged string if already registered", () => {
    const existing = JSON.stringify({ mcp: { unimcp: { type: "local", command: [BIN], enabled: true } } });
    expect(injectOpenCode(existing, BIN)).toBe(existing);
  });
});

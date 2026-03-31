import { describe, test, expect } from "bun:test";
import { loadConfig, isHttpServer } from "../src/config.js";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("isHttpServer", () => {
  test("returns true for http server", () => {
    expect(isHttpServer({ type: "http", url: "https://example.com" })).toBe(true);
  });

  test("returns false for stdio server", () => {
    expect(isHttpServer({ command: "npx" })).toBe(false);
  });
});

describe("loadConfig", () => {
  const dir = join(tmpdir(), `unimcp-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  test("loads valid config", () => {
    const file = join(dir, "valid.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        myserver: { command: "npx", args: ["my-mcp"] },
      },
    }));
    const config = loadConfig(file);
    expect(config.mcpServers["myserver"]).toEqual({ command: "npx", args: ["my-mcp"] });
  });

  test("expands ${VAR} env vars", () => {
    process.env.TEST_TOKEN = "abc123";
    const file = join(dir, "env-expand.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        server: { type: "http", url: "https://example.com", headers: { Authorization: "Bearer ${TEST_TOKEN}" } },
      },
    }));
    const config = loadConfig(file);
    const srv = config.mcpServers["server"];
    expect(isHttpServer(srv) && srv.headers?.["Authorization"]).toBe("Bearer abc123");
    delete process.env.TEST_TOKEN;
  });

  test("expands missing env var to empty string", () => {
    const file = join(dir, "missing-env.json");
    writeFileSync(file, '{"mcpServers": {"s": {"command": "${MISSING_VAR_XYZ}"}}}');
    const config = loadConfig(file);
    expect((config.mcpServers["s"] as { command: string }).command).toBe("");
  });

  test("loads clients section with tool filters", () => {
    const file = join(dir, "clients.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        searxng: { command: "searxng-mcp" },
      },
      clients: {
        copilot: { tools: { exclude: ["searxng__*"] } },
        claude: { tools: { include: ["*"] } },
      },
    }));
    const config = loadConfig(file);
    expect(config.clients?.["copilot"]).toEqual({ tools: { exclude: ["searxng__*"] } });
    expect(config.clients?.["claude"]).toEqual({ tools: { include: ["*"] } });
  });
});

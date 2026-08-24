import { describe, test, expect } from "bun:test";
import { loadConfig, loadRawConfig, isHttpServer, computeEnvHash, DEFAULT_MCP_FILE, resolveMcpFile } from "../src/config.js";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir, homedir } from "os";
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

  test("drops servers referencing an unset env var", () => {
    const file = join(dir, "missing-env.json");
    writeFileSync(file, '{"mcpServers": {"s": {"command": "${MISSING_VAR_XYZ}"}, "ok": {"command": "npx"}}}');
    const config = loadConfig(file);
    expect(config.mcpServers["s"]).toBeUndefined();
    expect(config.mcpServers["ok"]).toBeDefined();
  });

  test("drops servers referencing an empty env var", () => {
    process.env.EMPTY_VAR_XYZ = "";
    const file = join(dir, "empty-env.json");
    writeFileSync(file, '{"mcpServers": {"s": {"command": "npx", "env": {"T": "${EMPTY_VAR_XYZ}"}}}}');
    expect(loadConfig(file).mcpServers["s"]).toBeUndefined();
    delete process.env.EMPTY_VAR_XYZ;
  });

  test("expands ${VAR} in server names and object keys", () => {
    process.env.KEY_VAR_XYZ = "acme";
    const file = join(dir, "key-env.json");
    writeFileSync(file, '{"mcpServers": {"${KEY_VAR_XYZ}-gh": {"command": "npx", "env": {"${KEY_VAR_XYZ}_TOKEN": "t"}}}}');
    const srv = loadConfig(file).mcpServers["acme-gh"] as { env: Record<string, string> };
    expect(srv).toBeDefined();
    expect(srv.env["acme_TOKEN"]).toBe("t");
    delete process.env.KEY_VAR_XYZ;
  });

  test("does not warn for disabled servers with unset vars", () => {
    const file = join(dir, "disabled-env.json");
    writeFileSync(file, '{"mcpServers": {"s": {"command": "${MISSING_VAR_XYZ}", "enabled": false}}}');
    expect(loadConfig(file).mcpServers["s"]).toBeUndefined();
  });

  test("treats absent mcpServers as empty", () => {
    const file = join(dir, "no-servers.json");
    writeFileSync(file, "{}");
    expect(loadConfig(file).mcpServers).toEqual({});
  });

  test("rejects non-object mcpServers", () => {
    const file = join(dir, "bad-servers.json");
    writeFileSync(file, '{"mcpServers": []}');
    expect(() => loadConfig(file)).toThrow(/must be an object/);
  });

  test("keeps ${VAR} intact in raw config", () => {
    const file = join(dir, "raw-env.json");
    writeFileSync(file, '{"mcpServers": {"s": {"command": "${MISSING_VAR_XYZ}"}}}');
    const config = loadRawConfig(file);
    expect((config.mcpServers["s"] as { command: string }).command).toBe("${MISSING_VAR_XYZ}");
  });

  test("loads enabled field on servers", () => {
    const file = join(dir, "enabled.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        active: { command: "npx", enabled: true },
        disabled: { command: "npx", enabled: false },
        implicit: { command: "npx" },
      },
    }));
    const config = loadConfig(file);
    expect(config.mcpServers["active"].enabled).toBe(true);
    expect(config.mcpServers["disabled"].enabled).toBe(false);
    expect(config.mcpServers["implicit"].enabled).toBeUndefined();
  });
});

describe("computeEnvHash", () => {
  test("same env → same hash", () => {
    const file = join(tmpdir(), `unimcp-hash-same-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ url: "${FOO}", token: "${BAR}" }));
    process.env.FOO = "hello";
    process.env.BAR = "world";
    const hash1 = computeEnvHash(file);
    const hash2 = computeEnvHash(file);
    expect(hash1).toBe(hash2);
    delete process.env.FOO;
    delete process.env.BAR;
    unlinkSync(file);
  });

  test("different env → different hash", () => {
    const file = join(tmpdir(), `unimcp-hash-diff-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ url: "${FOO}" }));
    process.env.FOO = "x";
    const hash1 = computeEnvHash(file);
    process.env.FOO = "y";
    const hash2 = computeEnvHash(file);
    expect(hash1).not.toBe(hash2);
    delete process.env.FOO;
    unlinkSync(file);
  });

  test("no ${VAR} references → stable 8-char hex", () => {
    const file = join(tmpdir(), `unimcp-hash-novar-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    const hash1 = computeEnvHash(file);
    const hash2 = computeEnvHash(file);
    expect(hash1).toHaveLength(8);
    expect(hash1).toMatch(/^[0-9a-f]{8}$/);
    expect(hash1).toBe(hash2);
    unlinkSync(file);
  });

  test("missing file → returns 8-char hex string (does not throw)", () => {
    const hash = computeEnvHash("/tmp/does-not-exist-unimcp-test.json");
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("DEFAULT_MCP_FILE", () => {
  test("points to ~/.config/unimcp/unimcp.json", () => {
    expect(DEFAULT_MCP_FILE).toBe(join(homedir(), ".config", "unimcp", "unimcp.json"));
  });
});

describe("resolveMcpFile", () => {
  const localPath = "/tmp/test-project/unimcp.json";

  test("--mcp-file flag takes highest priority", () => {
    const result = resolveMcpFile({
      flagPath: "/custom/config.json",
      envConfig: "/env/config.json",
      localFileExists: true,
      localFilePath: localPath,
    });
    expect(result).toMatch(/config\.json$/);
  });

  test("--mcp-file=inline flag works", () => {
    const result = resolveMcpFile({
      flagPath: "/inline/path.json",
      envConfig: undefined,
      localFileExists: false,
      localFilePath: localPath,
    });
    expect(result).toMatch(/path\.json$/);
  });

  test("UNIMCP_CONFIG env takes second priority", () => {
    const result = resolveMcpFile({
      envConfig: "/env/config.json",
      localFileExists: true,
      localFilePath: localPath,
    });
    expect(result).toBe("/env/config.json");
  });

  test("local file takes third priority when it exists", () => {
    const result = resolveMcpFile({
      envConfig: undefined,
      localFileExists: true,
      localFilePath: localPath,
    });
    expect(result).toBe(localPath);
  });

  test("falls back to DEFAULT_MCP_FILE when nothing else matches", () => {
    const result = resolveMcpFile({
      envConfig: undefined,
      localFileExists: false,
      localFilePath: localPath,
    });
    expect(result).toBe(DEFAULT_MCP_FILE);
  });

  test("skips local file when it does not exist", () => {
    const result = resolveMcpFile({
      envConfig: undefined,
      localFileExists: false,
      localFilePath: localPath,
    });
    expect(result).not.toBe(localPath);
  });
});

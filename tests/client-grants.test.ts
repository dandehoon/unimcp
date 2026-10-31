import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clientGrantsPath, dropClientGrants, editClientGrants, isOwnGrantsFile, parseElapsed, readClientGrants,
} from "../src/client-grants.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "unimcp-client-grants-"));
  dirs.push(dir);
  return dir;
}

// This test process is a client that is certainly running.
const LIVE = process.pid;

describe("client grants", () => {
  test("edits add and remove, and drop clears the client", () => {
    const dir = configDir();
    expect(editClientGrants(LIVE, ["devdb", "+prod"], dir)).toEqual(["devdb", "prod"]);
    expect(editClientGrants(LIVE, ["-devdb"], dir)).toEqual(["prod"]);
    expect(readClientGrants(LIVE, dir)).toEqual(["prod"]);
    dropClientGrants(LIVE, dir);
    expect(existsSync(clientGrantsPath(LIVE, dir))).toBe(false);
  });

  test("an edit removes the files of clients no longer running", () => {
    const dir = configDir();
    mkdirSync(join(dir, "grants"));
    // Past the default pid range on both Linux and macOS, so never a live process.
    const exited = clientGrantsPath(2 ** 22 + 1, dir);
    writeFileSync(exited, "prod\n");
    editClientGrants(LIVE, ["devdb"], dir);
    expect(existsSync(exited)).toBe(false);
    expect(readClientGrants(LIVE, dir)).toEqual(["devdb"]);
  });

  test("a file written before the client started is not its own", () => {
    const dir = configDir();
    const file = clientGrantsPath(LIVE, dir);
    editClientGrants(LIVE, ["prod"], dir);
    const start = Date.now();
    expect(isOwnGrantsFile(file, start)).toBe(true);
    utimesSync(file, new Date(start - 60_000), new Date(start - 60_000));
    expect(isOwnGrantsFile(file, start)).toBe(false);
    expect(isOwnGrantsFile(join(dir, "absent"), start)).toBe(false);
  });

  test("parses ps elapsed times", () => {
    expect(parseElapsed("05:07")).toBe(307_000);
    expect(parseElapsed("02:05:07")).toBe(7_507_000);
    expect(parseElapsed("1-02:05:07")).toBe(93_907_000);
    expect(parseElapsed("garbage")).toBeUndefined();
  });
});

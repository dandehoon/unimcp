import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import { zshCompletion } from "../src/completion.js";

describe("zshCompletion", () => {
  const program = new Command("unimcp")
    .option("--port <number>", "Port")
    .addOption(new Option("--env-hash <hash>", "internal").hideHelp());
  program.command("stop <id>").description("Stop: by id");
  program.command("get <name>").description("Show one");
  program.command("add <name>").option("--env <KEY=VAL>", "repeatable", (v: string, all: string[]) => [...all, v], []);
  program.command("collect").option("-o, --output <path>", "Write output");
  const script = zshCompletion(program);

  test("completes daemon ids for an id and existing servers only where one is named", () => {
    expect(script).toContain("stop) _arguments ':id:_unimcp_ids' ;;");
    expect(script).toContain("get) _arguments ':name:_unimcp_servers' ;;");
    expect(script).toContain("':name:' ;;");
  });

  test("escapes descriptions, hides hidden options, repeats only collecting ones", () => {
    expect(script).toContain("'stop:Stop\\: by id'");
    expect(script).not.toContain("--env-hash");
    expect(script).toContain("'*--env[repeatable]:env:'");
    expect(script).toContain("'(--output -o)-o[Write output]:output:'");
    expect(script).toContain("'(--port)--port[Port]:port:'");
  });
});

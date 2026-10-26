import { describe, test, expect } from "bun:test";
import { substituteCommands } from "../src/substitute.js";

describe("substituteCommands", () => {
  test("replaces $(…) in env, headers and the OAuth client secret with trimmed stdout", async () => {
    const srv = await substituteCommands({
      url: "https://x.example",
      headers: { Authorization: "Bearer $(printf 'tok\\n')", Plain: "as-is" },
      oauth: { clientSecret: "$(echo s3cret)" },
    });
    expect(srv).toMatchObject({ headers: { Authorization: "Bearer tok", Plain: "as-is" }, oauth: { clientSecret: "s3cret" } });

    const stdio = await substituteCommands({ command: "x", env: { A: "$(echo a)-$(echo b)" } });
    expect(stdio).toMatchObject({ env: { A: "a-b" } });
  });

  test("leaves command and args alone: a substituted value there would show in `ps`", async () => {
    const srv = await substituteCommands({ command: "$(echo x)", args: ["$(echo y)"] });
    expect(srv).toEqual({ command: "$(echo x)", args: ["$(echo y)"] });
  });

  test("a failing or silent command fails the upstream, naming the exit code but not the output", async () => {
    // Built at run time, so the word only appears if the output is echoed, not the command.
    const failing = substituteCommands({ command: "x", env: { A: "$(printf 'lea%s' ked; printf 'lea%s' ked >&2; exit 3)" } });
    await expect(failing).rejects.toThrow(/exit 3/);
    await expect(failing).rejects.not.toThrow(/leaked/);
    await expect(substituteCommands({ command: "x", env: { A: "$(true)" } })).rejects.toThrow(/printed nothing/);
  });
});

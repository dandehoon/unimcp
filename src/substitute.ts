import { execFile } from "child_process";
import type { ServerConfig } from "./config.js";

const COMMAND_RE = /\$\(([^()]+)\)/g;
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Replaces each `$(command)` in `env`, `headers` and `oauth.clientSecret` with the command's
 * trimmed stdout, run through `sh -c`. Called as an upstream connects, so a secret is read only
 * when its server is used and a rotated one is picked up on reconnect. Never in `command`/`args`:
 * a value substituted there sits in the process's argv, readable by anyone through `ps`.
 * Runs after `${VAR}` expansion and `{var}` filling, so a `$(…)` arriving in either value runs
 * too — the same trust as the config file itself, which is where both come from or are named.
 */
export async function substituteCommands(srv: ServerConfig): Promise<ServerConfig> {
  const out: Record<string, unknown> = { ...srv };
  if ("env" in srv && srv.env) out.env = await substituteValues(srv.env);
  if ("headers" in srv && srv.headers) out.headers = await substituteValues(srv.headers);
  if ("oauth" in srv && srv.oauth?.clientSecret) {
    out.oauth = { ...srv.oauth, clientSecret: await substitute(srv.oauth.clientSecret) };
  }
  return out as ServerConfig;
}

async function substituteValues(values: Record<string, string>): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.entries(values).map(async ([k, v]) => [k, await substitute(v)] as const));
  return Object.fromEntries(entries);
}

async function substitute(value: string): Promise<string> {
  const commands = [...new Set([...value.matchAll(COMMAND_RE)].map((m) => m[1]))];
  if (!commands.length) return value;
  const outputs = new Map(await Promise.all(commands.map(async (c) => [c, await run(c)] as const)));
  return value.replace(COMMAND_RE, (_m, c: string) => outputs.get(c) ?? "");
}

/** Errors name the command and its exit code, never its output: stderr may echo the secret. */
function run(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], { timeout: COMMAND_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        const why = err.killed ? `timed out after ${COMMAND_TIMEOUT_MS / 1_000} s` : `exit ${err.code ?? "?"}`;
        return reject(new Error(`$(${command}) failed: ${why}`));
      }
      const output = stdout.trim();
      // An empty secret would connect with a blank credential and fail somewhere far less obvious.
      if (!output) return reject(new Error(`$(${command}) printed nothing`));
      resolve(output);
    });
  });
}

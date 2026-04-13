import { isHttpServer } from "./config.js";
import type { HttpServer, StdioServer, ServerConfig } from "./config.js";

export function formatListLine(name: string, srv: ServerConfig): string {
  if (isHttpServer(srv)) return `${name}  http  ${srv.url}`;
  const argsPart = srv.args?.length ? `  ${srv.args.join(" ")}` : "";
  return `${name}  stdio  ${srv.command}${argsPart}`;
}

export function formatServer(srv: ServerConfig): string[] {
  return isHttpServer(srv) ? formatHttpServer(srv) : formatStdioServer(srv);
}

export function formatHttpServer(srv: HttpServer): string[] {
  const lines: string[] = [`type:  http`, `url:   ${maskUrl(srv.url)}`];
  const headerEntries = srv.headers ? Object.entries(srv.headers) : [];
  if (headerEntries.length > 0) {
    lines.push(`headers:`);
    for (const [k, v] of headerEntries) lines.push(`  ${k}: ${maskValue(k, v)}`);
  } else {
    lines.push(`headers: (none)`);
  }
  return lines;
}

export function formatStdioServer(srv: StdioServer): string[] {
  const lines: string[] = [
    `type:    stdio`,
    `command: ${srv.command}`,
    `args:    ${srv.args?.length ? srv.args.join(" ") : "(none)"}`,
  ];
  const envEntries = srv.env ? Object.entries(srv.env) : [];
  if (envEntries.length > 0) {
    lines.push(`env:`);
    for (const [k, v] of envEntries) lines.push(`  ${k}=${maskValue(k, v)}`);
  } else {
    lines.push(`env:     (none)`);
  }
  return lines;
}

// --- helpers ---

const SECRET_KEYWORDS = ["key", "token", "secret", "auth", "bearer", "password"];
const SECRET_RE = new RegExp(SECRET_KEYWORDS.join("|"), "i");

function maskValue(key: string, value: string): string {
  return SECRET_RE.test(key) ? "***" : value;
}

function maskUrl(raw: string): string {
  if (!raw.includes("?")) return raw;
  try {
    const u = new URL(raw);
    for (const [k] of u.searchParams) {
      if (SECRET_RE.test(k)) u.searchParams.set(k, "***");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

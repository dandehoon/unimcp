/** Write to stderr without color (avoids Bun's red console.error). */
export function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

export function parseFlagValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx !== -1) return argv[idx + 1] ?? null;
  const inline = argv.find((a) => a.startsWith(flag + "="));
  return inline ? inline.slice(flag.length + 1) : null;
}

export function stripJsonComments(raw: string): string {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      result += raw[i++];
      while (i < raw.length) {
        const ch = raw[i];
        result += ch;
        i++;
        if (ch === "\\" && i < raw.length) { result += raw[i++]; continue; }
        if (ch === '"') break;
      }
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i < raw.length) i += 2;
      continue;
    }
    result += raw[i++];
  }
  return result;
}

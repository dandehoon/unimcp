/**
 * Strips // line comments and /* block comments from JSONC input,
 * respecting quoted string boundaries.
 */
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
      i += 2;
      continue;
    }
    result += raw[i++];
  }
  return result;
}

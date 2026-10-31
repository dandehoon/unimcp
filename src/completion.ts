import { homedir } from "os";
import type { Command, Option } from "commander";
import { CONFIG_DIR } from "./config.js";

// zsh completion, generated from the CLI's own commands and options so it can't drift from them.

/** Commands whose `<name>` is an existing server; `add`'s is a new one, so it gets no candidates. */
const EXISTING_SERVER_COMMANDS = new Set(["get", "remove", "auth"]);

/**
 * The script works both as an fpath file named `_unimcp` (what `install-bin` writes) and
 * through `eval "$(unimcp completion)"`.
 */
export function zshCompletion(program: Command): string {
  const commands = program.commands.map((c) => `    ${quote(`${c.name()}:${c.description().replaceAll(":", "\\:")}`)}`);
  const cases = program.commands.map((c) => {
    const specs = [...c.options.flatMap(optionSpecs), ...argumentSpecs(c)];
    return `    ${c.name()}) ${specs.length ? `_arguments ${specs.join(" ")}` : ":"} ;;`;
  });
  return `#compdef unimcp

_unimcp_ids() {
  local -a ids=(${configDir()}/daemon.*.pid(N:t:r:e))
  _describe -t daemons 'daemon id' ids
}

_unimcp_servers() {
  # First column of \`unimcp list\` (it prints through stderr, like every unimcp log); only its
  # "name  type  …" rows, not a "(no servers configured)" or an error.
  local -a rows=(\${(M)\${(f)"$(unimcp list 2>&1)"}:#[^[:space:](]##  [a-z]##  *})
  local -a servers=(\${rows%%[[:space:]]*})
  _describe -t servers server servers
}

_unimcp() {
  local curcontext=$curcontext state line
  _arguments -C ${program.options.flatMap(optionSpecs).join(" ")} '1: :->command' '*:: :->args'
  case $state in
    command)
      local -a commands=(
${commands.join("\n")}
      )
      _describe -t commands command commands ;;
    args)
      curcontext=\${curcontext%:*:*}:unimcp-$words[1]:
      case $words[1] in
${cases.join("\n")}
      esac ;;
  esac
}

if [[ $zsh_eval_context[-1] == loadautofunc ]]; then
  _unimcp "$@"
else
  compdef _unimcp unimcp
fi
`;
}

// --- helpers ---

/** `$HOME`-relative where it can be, so a script generated under sudo still finds the user's daemons. */
function configDir(): string {
  const home = homedir();
  return CONFIG_DIR.startsWith(home) ? `"$HOME"${quote(CONFIG_DIR.slice(home.length))}` : quote(CONFIG_DIR);
}

function optionSpecs(opt: Option): string[] {
  if (opt.hidden) return [];
  const help = opt.description.replaceAll("[", "\\[").replaceAll("]", "\\]");
  const value = opt.required || opt.optional ? `:${opt.attributeName()}:${opt.long === "--mcp-file" ? "_files" : ""}` : "";
  const flags = [opt.long, opt.short].filter((f): f is string => Boolean(f));
  // A repeatable option (--env, --header) collects into an array default; the rest are offered
  // once, with a short and long form excluding each other.
  const once = Array.isArray(opt.defaultValue) || opt.variadic ? "*" : `(${flags.join(" ")})`;
  return flags.map((flag) => quote(`${once}${flag}[${help}]${value}`));
}

function argumentSpecs(cmd: Command): string[] {
  return cmd.registeredArguments.map((arg) => {
    const name = arg.name();
    const action = name === "id" ? "_unimcp_ids" : name === "name" && EXISTING_SERVER_COMMANDS.has(cmd.name()) ? "_unimcp_servers" : "";
    return quote(`${arg.required ? ":" : "::"}${name}:${action}`);
  });
}

function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

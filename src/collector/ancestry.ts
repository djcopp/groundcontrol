import { isAbsolute, join } from "node:path";
import type { ProcessKind } from "../shared/types.js";
import { isClaudeAgent, type RawProcess } from "./processes.js";

export interface Classification {
  kind: ProcessKind;
  label: string;
  /** For interpreters: the script/module argument (may be relative). */
  script?: string;
}

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

const TERMINALS: [RegExp, string][] = [
  [/Terminal\.app\//, "Terminal"],
  [/iTerm(2)?\.app\//, "iTerm2"],
  [/[Gg]hostty/, "Ghostty"],
  [/[Ww]ez[Tt]erm/, "WezTerm"],
  [/[Aa]lacritty/, "Alacritty"],
  [/kitty(\.app)?(\/|$)/, "kitty"],
  [/Warp\.app\//, "Warp"],
  [/Hyper\.app\//, "Hyper"],
  [/Tabby\.app\//, "Tabby"],
  [/gnome-terminal/, "GNOME Terminal"],
  [/konsole$/, "Konsole"],
  [/(^|\/)(xterm|urxvt|foot|st)$/, "Terminal"],
];

const IDES: [RegExp, string][] = [
  [/Visual Studio Code( - Insiders)?\.app\/|(^|\/)code(-insiders)?$|Code Helper/, "VS Code"],
  [/Cursor\.app\/|(^|\/)cursor$/, "Cursor"],
  [/Windsurf\.app\//, "Windsurf"],
  [/Zed( Preview)?\.app\/|(^|\/)zed$/, "Zed"],
  [
    /(IntelliJ IDEA|PyCharm|WebStorm|GoLand|RustRover|CLion|PhpStorm|Rider|DataSpell|Fleet)[^/]*\.app\//,
    "JetBrains",
  ],
  [/(^|\/)n?vim$/, "Vim"],
  [/(^|\/)[Ee]macs/, "Emacs"],
];

const SHELLS = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "nu",
  "pwsh",
  "elvish",
]);
const WRAPPERS = new Set([
  "login",
  "sudo",
  "env",
  "nohup",
  "caffeinate",
  "script",
  "timeout",
  "stdbuf",
  "direnv",
  "disclaimer",
  "time",
  "exec",
]);
const INTERPRETER_RE =
  /^(python(\d+(\.\d+)?)?|node|bun|deno|ruby|perl|php|uv|uvx|npx|pnpm|yarn|npm|tsx|ts-node|make|just|cargo|go)$/;

const UV_VALUE_FLAGS = new Set([
  "--with",
  "--with-requirements",
  "--python",
  "-p",
  "--project",
  "--directory",
  "--env-file",
  "--extra",
  "--group",
  "--package",
  "--index",
  "--from",
]);

/** Interpreter flags whose value is the next argument, so it is not mistaken for the script. */
const PY_VALUE_FLAGS = new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"]);
const JS_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--inspect-port",
  "--title",
  "--conditions",
  "-C",
  "--config",
]);

/** Split a ps command line into argv. ps does not quote, so this is best effort. */
export function splitCommand(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

/** Find the script/module an interpreter was asked to run. */
export function extractScript(interp: string, args: string[]): string | undefined {
  const base = basename(interp);
  if (/^python/.test(base)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "-m") return args[i + 1] ? `-m ${args[i + 1]}` : undefined;
      if (a === "-c") return "-c (inline)";
      if (PY_VALUE_FLAGS.has(a)) {
        i++; // skip the flag's value
        continue;
      }
      if (a.startsWith("-")) continue;
      return a;
    }
    return undefined;
  }
  if (base === "uv" || base === "uvx") {
    const runIdx = args.indexOf("run");
    const rest = runIdx >= 0 ? args.slice(runIdx + 1) : args;
    let i = 0;
    while (i < rest.length) {
      const a = rest[i] ?? "";
      if (!a.startsWith("-")) break;
      // flags that take a value as the next argument
      i += !a.includes("=") && UV_VALUE_FLAGS.has(a) ? 2 : 1;
    }
    const target = rest[i];
    if (!target) return undefined;
    if (/^python/.test(target)) return extractScript(target, rest.slice(i + 1));
    return target;
  }
  if (["npx", "pnpm", "yarn", "npm", "make", "just", "cargo", "go"].includes(base)) {
    const words = args.filter((a) => !a.startsWith("-")).slice(0, 2);
    return words.length ? `${base} ${words.join(" ")}` : undefined;
  }
  // node, bun, deno, ruby, tsx...: first non-flag argument (skip deno's and bun's `run`).
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") return "-e (inline)";
    if (JS_VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (!a.startsWith("-")) positional.push(a);
  }
  if ((base === "deno" || base === "bun") && positional[0] === "run") return positional[1];
  return positional[0];
}

export function classify(p: Pick<RawProcess, "pid" | "comm" | "command">): Classification {
  const { comm, command } = p;
  const exeBase = basename(comm).replace(/^-/, "");
  if (p.pid === 1)
    return { kind: "init", label: process.platform === "darwin" ? "launchd" : "init" };
  if (isClaudeAgent(p)) return { kind: "agent", label: "claude" };
  if (/\/Claude\.app\/Contents\/MacOS\/Claude$/.test(comm) || /(^|\/)claude-desktop$/.test(comm))
    return { kind: "desktop-app", label: "Claude Desktop" };
  if (WRAPPERS.has(exeBase) || /\/Helpers\/disclaimer$/.test(comm))
    return { kind: "wrapper", label: exeBase };
  for (const [re, label] of TERMINALS) if (re.test(comm)) return { kind: "terminal", label };
  for (const [re, label] of IDES) if (re.test(comm)) return { kind: "ide", label };
  if (/^(tmux|screen|zellij)/.test(exeBase))
    return { kind: "multiplexer", label: exeBase.split(":")[0] ?? exeBase };
  if (/^(sshd|mosh-server|ssh)$/.test(exeBase) || /^sshd:/.test(command))
    return { kind: "remote", label: "SSH" };
  if (SHELLS.has(exeBase)) return { kind: "shell", label: exeBase };
  if (/^(cron|crond|launchd)$/.test(exeBase)) return { kind: "other", label: exeBase };
  // macOS framework builds re-exec as .../Python.app/Contents/MacOS/Python, so match case-insensitively.
  const interp = exeBase.toLowerCase();
  if (INTERPRETER_RE.test(interp)) {
    // Drop argv0 by the known executable path when possible, so a path with spaces stays whole.
    const rest = command.startsWith(comm)
      ? command.slice(comm.length)
      : command.replace(/^\S+/, "");
    const script = extractScript(interp, splitCommand(rest));
    let label = interp;
    if (script?.startsWith(`${interp} `))
      label = script; // "pnpm run agents"
    else if (script && (script.startsWith("-") || script.includes(" ")))
      label = `${interp} ${script}`;
    else if (script) label = basename(script);
    return { kind: "script", label, script };
  }
  // Any other .app on macOS: show the app name.
  const app = comm.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
  if (app?.[1]) return { kind: "other", label: app[1] };
  return { kind: "other", label: exeBase };
}

/** Resolve a script argument to an absolute path when it looks like a file. */
export function resolveScript(
  script: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!script || script.startsWith("-") || script.includes(" ")) return script;
  if (isAbsolute(script)) return script;
  if (cwd) return join(cwd, script);
  return script;
}

/** Walk ppid links from `pid`'s parent upwards. Returns pids nearest-first, ending at init. */
export function ancestorPids(pid: number, procs: Map<number, Pick<RawProcess, "ppid">>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = procs.get(pid)?.ppid;
  while (cur !== undefined && cur > 0 && !seen.has(cur) && out.length < 40) {
    out.push(cur);
    seen.add(cur);
    cur = procs.get(cur)?.ppid;
  }
  return out;
}

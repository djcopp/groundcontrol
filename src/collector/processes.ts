import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RawProcess {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  /** Elapsed seconds since the process started. */
  elapsedSec: number;
  /** Full command line (argv joined by spaces, as ps prints it). */
  command: string;
  /** Executable path or name, as ps reports `comm`. */
  comm: string;
}

/** Parse ps `etime` ([[dd-]hh:]mm:ss) into seconds. */
export function parseEtime(etime: string): number {
  const trimmed = etime.trim();
  if (!trimmed) return 0;
  let days = 0;
  let rest = trimmed;
  const dash = trimmed.indexOf("-");
  if (dash >= 0) {
    days = Number(trimmed.slice(0, dash));
    rest = trimmed.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + (Number.isFinite(p) ? p : 0);
  return days * 86400 + seconds;
}

/**
 * Parse `ps -o pid=,ppid=,pcpu=,rss=,etime=,command=` output.
 * The command is the last column so it may contain spaces.
 */
export function parsePsStats(output: string): Map<number, Omit<RawProcess, "comm">> {
  const out = new Map<number, Omit<RawProcess, "comm">>();
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, {
      pid,
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssKb: Number(m[4]),
      elapsedSec: parseEtime(m[5] ?? ""),
      command: (m[6] ?? "").trim(),
    });
  }
  return out;
}

/** Parse `ps -o pid=,comm=` output. */
export function parsePsComm(output: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*(\d+)\s(.*)$/);
    if (!m) continue;
    out.set(Number(m[1]), (m[2] ?? "").trim());
  }
  return out;
}

export async function listProcesses(): Promise<Map<number, RawProcess>> {
  const opts = { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
  const [stats, comms] = await Promise.all([
    execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,pcpu=,rss=,etime=,command="], opts),
    execFileAsync("ps", ["-axww", "-o", "pid=,comm="], opts),
  ]);
  const statMap = parsePsStats(stats.stdout);
  const commMap = parsePsComm(comms.stdout);
  const out = new Map<number, RawProcess>();
  for (const [pid, s] of statMap) {
    out.set(pid, { ...s, comm: commMap.get(pid) ?? s.command.split(" ")[0] ?? "" });
  }
  return out;
}

/** Parse `lsof -Fpn` output into pid -> path. */
export function parseLsofCwd(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) out.set(pid, line.slice(1));
  }
  return out;
}

/** Look up the working directory of each pid. Missing entries mean "not permitted / gone". */
export async function getCwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === "linux") {
    const out = new Map<number, string>();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          // process gone or not ours
        }
      }),
    );
    return out;
  }
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return parseLsofCwd(stdout);
  } catch (err) {
    // lsof exits 1 when some pids have vanished but still prints the rest.
    const stdout = (err as { stdout?: string }).stdout;
    return stdout ? parseLsofCwd(stdout) : new Map();
  }
}

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/**
 * Is this process a Claude Code agent?
 * Covers the native binary (`claude`, or `~/.local/share/claude/versions/x.y.z`),
 * the desktop-bundled `claude.app`, and the npm build run through node (`.../claude-code/cli.js`).
 */
export function isClaudeAgent(p: Pick<RawProcess, "comm" | "command">): boolean {
  const comm = p.comm;
  const argv0 = p.command.split(" ")[0] ?? "";
  if (basename(comm) === "claude" || basename(argv0) === "claude") return true;
  if (/\/claude\/versions\/[\d.]+[^/]*$/.test(comm)) return true;
  const base = basename(comm);
  if (
    /^(node|bun|deno)$/.test(base) &&
    /@anthropic-ai\/claude-(code|agent-sdk)\/cli\.m?js\b/.test(p.command)
  )
    return true;
  return false;
}

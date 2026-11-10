import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Claude Code writes `<claudeDir>/sessions/<pid>.json` for each running interactive session.
 * Only the `.json` files are read: the sibling `.key` files hold peer tokens and are never opened.
 */
export interface SessionFile {
  pid: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  statusUpdatedAt?: number;
}

export function parseSessionFile(text: string): SessionFile | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.pid !== "number") return undefined;
    const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined);
    const n = (k: string) => (typeof j[k] === "number" ? (j[k] as number) : undefined);
    return {
      pid: j.pid,
      sessionId: s("sessionId"),
      cwd: s("cwd"),
      startedAt: n("startedAt"),
      version: s("version"),
      kind: s("kind"),
      entrypoint: s("entrypoint"),
      name: s("name"),
      status: s("status"),
      statusUpdatedAt: n("statusUpdatedAt"),
    };
  } catch {
    return undefined;
  }
}

export async function readSessionFiles(claudeDir: string): Promise<Map<number, SessionFile>> {
  const dir = join(claudeDir, "sessions");
  const out = new Map<number, SessionFile>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const parsed = parseSessionFile(await readFile(join(dir, n), "utf8"));
          if (parsed) out.set(parsed.pid, parsed);
        } catch {
          // removed between readdir and read
        }
      }),
  );
  return out;
}

/** Pull a session id out of the agent's command line (`--resume <id>`, `--session-id=<id>`...). */
export function sessionIdFromArgs(command: string): string | undefined {
  const m = command.match(
    /(?:--resume|--session-id|-r)(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return m?.[1];
}

/** Claude Code stores transcripts under projects/<cwd with every non-alphanumeric char as "-">. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Best guess of how an agent was started, from its session file and argv. */
export function guessEntrypoint(command: string, session?: SessionFile): string {
  if (session?.entrypoint) return session.entrypoint;
  if (/claude_agent_sdk|claude-agent-sdk/.test(command)) return "sdk";
  if (/--output-format[= ]stream-json/.test(command)) return "sdk / stream-json";
  if (/(^|\s)(-p|--print)(\s|$)/.test(command)) return "headless (-p)";
  return "cli";
}

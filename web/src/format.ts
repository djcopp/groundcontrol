import type { AgentState } from "../../src/shared/types.js";

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Compact duration for tight spaces: 45s, 12m, 3h, 2d. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Aviation term first, plain meaning second, so the theme never hides what is going on. */
export const STATE_LABEL: Record<AgentState, string> = {
  thinking: "In flight, thinking",
  tool: "Taxiing, running a tool",
  blocked: "Awaiting clearance, needs your permission",
  waiting: "Holding, waiting for you",
  done: "Landed, handed back to its caller",
  ended: "Landed, process exited",
  unknown: "No signal",
};

export const STATE_SHORT: Record<AgentState, string> = {
  thinking: "in flight",
  tool: "taxiing",
  blocked: "clearance",
  waiting: "holding",
  done: "landed",
  ended: "landed",
  unknown: "no signal",
};

/** "ended" and "done" are both landed: one chip, one highlight. */
export const sameStatus = (a: AgentState, b: AgentState) =>
  a === b || (a === "ended" && b === "done") || (a === "done" && b === "ended");

const CALL_PREFIX: Record<string, string> = {
  Terminal: "TRM",
  iTerm2: "ITM",
  Ghostty: "GST",
  WezTerm: "WEZ",
  Alacritty: "ALC",
  Warp: "WRP",
  "VS Code": "VSC",
  Cursor: "CSR",
  Windsurf: "WSF",
  Zed: "ZED",
  JetBrains: "JBR",
  "Claude Desktop": "CLD",
  tmux: "TMX",
  SSH: "SSH",
  Background: "BGD",
};

/** A flight number from the airport (launcher) and the pid: VS Code + pid 52482 -> VSC482. */
export function flightNumber(pid: number | undefined, launcher: string): string {
  const prefix =
    CALL_PREFIX[launcher] ??
    (launcher
      .replace(/\.[a-z]+$/i, "")
      .replace(/[^a-z]/gi, "")
      .slice(0, 3)
      .toUpperCase()
      .padEnd(3, "X") ||
      "AGT");
  return `${prefix}${pid ? String(pid % 1000).padStart(3, "0") : ""}`;
}

export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (m) return `${m[1]} ${m[2]}.${m[3]}`;
  return model.replace(/^claude-/, "");
}

export function homeRelative(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

/** "mcp__github__list_prs" -> "github › list_prs"; built-in tools unchanged. */
export function toolName(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]} › ${m[2]}` : name;
}

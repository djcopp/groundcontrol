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

export const STATE_LABEL: Record<AgentState, string> = {
  thinking: "Thinking",
  tool: "Running tool",
  blocked: "Needs permission",
  waiting: "Waiting for you",
  done: "Done",
  ended: "Exited",
  unknown: "Unknown",
};

export const STATE_SHORT: Record<AgentState, string> = {
  thinking: "thinking",
  tool: "tool",
  blocked: "blocked",
  waiting: "waiting",
  done: "done",
  ended: "exited",
  unknown: "?",
};

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

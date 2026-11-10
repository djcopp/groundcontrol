/**
 * Shared data model between the collector (Node) and the web UI.
 * Everything in a Snapshot is safe to serialise to JSON.
 */

/** What an agent is doing right now. */
export type AgentState =
  /** Model is generating (thinking / writing a reply). */
  | "thinking"
  /** A tool call is in flight (Bash, Edit, an MCP call...). */
  | "tool"
  /** A tool call is pending but the session reports idle: almost always a permission prompt. */
  | "blocked"
  /** The turn ended; the agent is waiting for a human to say something. */
  | "waiting"
  /** Subagent that has handed back, or a session whose process has exited. */
  | "done"
  /** Process is gone; kept on screen for a short while so you see it leave. */
  | "ended"
  /** We found the process but could not read any session data for it. */
  | "unknown";

/** States in which an agent is consuming compute (fluid flows through its pipe). */
export const FLOWING_STATES: ReadonlySet<AgentState> = new Set(["thinking", "tool"]);
/** States in which an agent needs a human. */
export const ATTENTION_STATES: ReadonlySet<AgentState> = new Set(["blocked", "waiting"]);

/** Classification of a process in an agent's launch chain. */
export type ProcessKind =
  | "agent"
  | "desktop-app"
  | "terminal"
  | "ide"
  | "multiplexer"
  | "remote"
  | "script"
  | "shell"
  | "wrapper"
  | "init"
  | "other";

export interface ProcessNode {
  pid: number;
  ppid: number;
  kind: ProcessKind;
  /** Short human label, e.g. "iTerm2", "tmux", "orchestrate.py". */
  label: string;
  /** Executable path (or name when the path is unknown). */
  exe: string;
  /** Full command line, truncated. */
  command: string;
  cwd?: string;
  /** For interpreters: the script or module being run, resolved against cwd when possible. */
  script?: string;
  cpu: number;
  rssMb: number;
  /** Process start time, ms since epoch. */
  startedAt?: number;
}

export interface ToolEvent {
  id: string;
  name: string;
  /** Short description of the call ("pnpm test", "src/app.ts", ...). Empty when details are hidden. */
  summary: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
}

export type TimelineState = "thinking" | "tool" | "blocked" | "waiting" | "done";

export interface TimelineSegment {
  state: TimelineState;
  start: number;
  end: number;
}

export interface GitInfo {
  root: string;
  branch?: string;
  /** Detached HEAD commit, short form. */
  commit?: string;
}

export interface Agent {
  /** Stable id: "pid:<pid>" for processes, "sub:<sessionId>:<agentId>" for subagents. */
  id: string;
  kind: "agent" | "subagent";
  pid?: number;
  /** For subagents: the id of the agent that spawned it. For nested CLI agents: the outer agent. */
  parentAgentId?: string;
  name: string;
  sessionId?: string;
  cwd?: string;
  project?: string;
  git?: GitInfo;
  /** How it was started: "cli", "claude-desktop", "sdk-py", "sdk-ts", ... */
  entrypoint?: string;
  /** Subagent type, e.g. "general-purpose", "Explore". */
  agentType?: string;
  model?: string;
  state: AgentState;
  /** When the agent entered its current state (ms). */
  stateSince: number;
  currentTool?: ToolEvent;
  lastActivityAt?: number;
  startedAt?: number;
  cpu: number;
  rssMb: number;
  tokens: { input: number; output: number; cacheRead: number };
  /** Most recent tool calls, newest last. */
  recentTools: ToolEvent[];
  timeline: TimelineSegment[];
  /** Pids from the agent's parent up to the top of its launch chain (nearest first). */
  ancestry: number[];
  /** Number of tool calls seen in the transcript window. */
  toolCount: number;
  ended?: boolean;
}

export interface Snapshot {
  generatedAt: number;
  mode: "live" | "demo";
  host: string;
  platform: string;
  /** Duration of the timeline window, ms. */
  windowMs: number;
  agents: Agent[];
  /** Every process referenced by an agent's ancestry, keyed by pid. */
  processes: Record<string, ProcessNode>;
  warnings: string[];
}

export interface CodeSnippet {
  line: number;
  /** Lines around the match, with their 1-based numbers. */
  lines: { n: number; text: string; hit: boolean }[];
}

export interface CodeTrace {
  pid: number;
  label: string;
  file: string;
  snippets: CodeSnippet[];
  error?: string;
}

export interface TraceResponse {
  agentId: string;
  chain: ProcessNode[];
  code: CodeTrace[];
}

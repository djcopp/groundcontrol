import { open, stat } from "node:fs/promises";
import type { TimelineSegment, TimelineState, ToolEvent } from "../shared/types.js";

/** How much of an existing transcript to read on first sight. */
const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_TOOLS = 25;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

const shortPath = (p: string) => p.split("/").slice(-2).join("/");

/** One-line description of a tool call, from its input. */
export function summariseToolInput(name: string, input: unknown): string {
  if (!isObj(input)) return "";
  const s = (k: string) => str(input[k]);
  switch (name) {
    case "Bash":
      return truncate(s("description") ?? s("command") ?? "", 80);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return shortPath(s("file_path") ?? s("notebook_path") ?? "");
    case "Grep":
    case "Glob":
      return truncate(s("pattern") ?? "", 60);
    case "Agent":
    case "Task":
      return truncate(s("description") ?? s("subagent_type") ?? "", 70);
    case "WebFetch":
      try {
        return new URL(s("url") ?? "").host;
      } catch {
        return "";
      }
    case "WebSearch":
      return truncate(s("query") ?? "", 60);
    case "TodoWrite":
      return "update todos";
    default: {
      for (const k of ["description", "command", "query", "path", "file_path", "url", "name"]) {
        const v = s(k);
        if (v) return truncate(v, 60);
      }
      return "";
    }
  }
}

export interface TranscriptOptions {
  /** Keep tool summaries; when false only tool names are kept. */
  details: boolean;
  windowMs: number;
}

/**
 * Incrementally parses a Claude Code transcript (JSONL) and tracks what the agent is doing.
 *
 * State machine, driven by records:
 *   user prompt            -> thinking
 *   assistant tool_use     -> tool       (until every pending tool has a result)
 *   user tool_result       -> thinking   (once no tools are pending)
 *   assistant end_turn     -> waiting
 *   system turn_duration   -> waiting
 *   "[Request interrupted" -> waiting
 *   SubagentHandback       -> done
 */
export class TranscriptTracker {
  readonly path: string;
  private offset = -1;
  private partial = "";
  private size = 0;
  private lastMsgId: string | undefined;
  private skipFirstLine = false;
  private readonly opts: TranscriptOptions;

  state: TimelineState = "waiting";
  stateSince = 0;
  segments: TimelineSegment[] = [];
  pending = new Map<string, ToolEvent>();
  recentTools: ToolEvent[] = [];
  toolCount = 0;
  /** tool_use ids of Agent/Task calls: subagents link back to these. */
  agentToolIds = new Set<string>();
  model: string | undefined;
  tokens = { input: 0, output: 0, cacheRead: 0 };
  firstActivityAt: number | undefined;
  lastActivityAt: number | undefined;
  handedBack = false;
  /** Most recent custom title / agent name seen in the transcript. */
  title: string | undefined;
  /** cwd recorded on transcript entries. */
  cwd: string | undefined;

  constructor(path: string, opts: TranscriptOptions) {
    this.path = path;
    this.opts = opts;
  }

  /** Read anything appended since the last call. Returns false if the file is unreadable. */
  async update(): Promise<boolean> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(this.path);
    } catch {
      return false;
    }
    if (st.size < this.size) this.reset(); // truncated / rewritten
    if (this.offset < 0) {
      this.offset = Math.max(0, st.size - INITIAL_TAIL_BYTES);
      this.partial = "";
      if (this.offset > 0) this.skipFirstLine = true;
    }
    if (st.size === this.offset) {
      this.size = st.size;
      return true;
    }
    const fh = await open(this.path, "r");
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      this.offset = st.size;
      this.size = st.size;
      this.ingestText(buf.toString("utf8"));
    } finally {
      await fh.close();
    }
    return true;
  }

  private reset() {
    this.offset = -1;
    this.size = 0;
    this.partial = "";
    this.state = "waiting";
    this.stateSince = 0;
    this.segments = [];
    this.pending.clear();
    this.recentTools = [];
    this.toolCount = 0;
    this.agentToolIds.clear();
    this.tokens = { input: 0, output: 0, cacheRead: 0 };
    this.lastMsgId = undefined;
    this.handedBack = false;
  }

  /** Feed raw JSONL text (exposed for tests). */
  ingestText(text: string) {
    const data = this.partial + text;
    const lines = data.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (this.skipFirstLine) {
        this.skipFirstLine = false;
        continue; // first line of a tail read is probably cut in half
      }
      if (!line.trim()) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObj(rec)) this.ingest(rec);
    }
  }

  private transition(next: TimelineState, ts: number) {
    if (this.stateSince === 0) {
      this.state = next;
      this.stateSince = ts;
      return;
    }
    if (next === this.state) return;
    if (ts > this.stateSince) {
      this.segments.push({ state: this.state, start: this.stateSince, end: ts });
    }
    this.state = next;
    this.stateSince = Math.max(ts, this.stateSince);
    this.prune(ts);
  }

  private prune(now: number) {
    const cutoff = now - this.opts.windowMs;
    if (this.segments.length > 0 && (this.segments[0]?.end ?? 0) < cutoff) {
      this.segments = this.segments.filter((s) => s.end >= cutoff);
    }
    if (this.segments.length > 2000) this.segments = this.segments.slice(-2000);
  }

  private ingest(rec: Json) {
    const type = str(rec.type);
    const ts = Date.parse(str(rec.timestamp) ?? "");
    if (!Number.isFinite(ts)) {
      if (type === "custom-title" || type === "agent-name") {
        this.title = str(rec.customTitle) ?? str(rec.agentName) ?? this.title;
      }
      return;
    }
    if (type !== "user" && type !== "assistant" && type !== "system") return;
    if (str(rec.cwd)) this.cwd = str(rec.cwd);
    this.firstActivityAt ??= ts;
    this.lastActivityAt = Math.max(this.lastActivityAt ?? 0, ts);
    const msg = isObj(rec.message) ? rec.message : undefined;

    if (type === "system") {
      if (str(rec.subtype) === "turn_duration" && this.pending.size === 0) {
        this.transition("waiting", ts);
      }
      return;
    }

    if (type === "user") {
      if (rec.isMeta === true || !msg) return;
      const content = msg.content;
      if (typeof content === "string") {
        this.onPrompt(content, ts);
        return;
      }
      if (!Array.isArray(content)) return;
      let sawResult = false;
      let promptText = "";
      for (const item of content) {
        if (!isObj(item)) continue;
        if (item.type === "tool_result") {
          sawResult = true;
          const id = str(item.tool_use_id) ?? "";
          const ev = this.pending.get(id);
          if (ev) {
            ev.endedAt = ts;
            ev.isError = item.is_error === true;
            this.pending.delete(id);
            if (ev.name === "SubagentHandback") this.handedBack = true;
          }
        } else if (item.type === "text") {
          promptText += str(item.text) ?? "";
        }
      }
      if (sawResult) {
        if (this.handedBack) this.transition("done", ts);
        else if (this.pending.size === 0) this.transition("thinking", ts);
      } else if (promptText) {
        this.onPrompt(promptText, ts);
      }
      return;
    }

    // assistant
    if (!msg) return;
    this.model = str(msg.model) ?? this.model;
    const msgId = str(msg.id);
    if (msgId && msgId !== this.lastMsgId && isObj(msg.usage)) {
      this.lastMsgId = msgId;
      const u = msg.usage;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      this.tokens.input += n("input_tokens") + n("cache_creation_input_tokens");
      this.tokens.cacheRead += n("cache_read_input_tokens");
      this.tokens.output += n("output_tokens");
    }
    let sawTool = false;
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (!isObj(item) || item.type !== "tool_use") continue;
        const id = str(item.id) ?? `t${ts}`;
        if (this.pending.has(id)) continue;
        const name = str(item.name) ?? "tool";
        const ev: ToolEvent = {
          id,
          name,
          summary: this.opts.details ? summariseToolInput(name, item.input) : "",
          startedAt: ts,
        };
        this.pending.set(id, ev);
        this.recentTools.push(ev);
        if (this.recentTools.length > MAX_RECENT_TOOLS) this.recentTools.shift();
        this.toolCount++;
        if (name === "Agent" || name === "Task") this.agentToolIds.add(id);
        sawTool = true;
      }
    }
    if (sawTool || this.pending.size > 0) {
      this.transition("tool", ts);
    } else if (msg.stop_reason === "end_turn") {
      this.transition("waiting", ts);
    } else {
      this.transition("thinking", ts);
    }
  }

  private onPrompt(text: string, ts: number) {
    if (/^\s*\[Request interrupted/.test(text)) {
      for (const ev of this.pending.values()) ev.endedAt = ts;
      this.pending.clear();
      this.transition("waiting", ts);
      return;
    }
    // Local command output / caveats are not real prompts.
    if (/^\s*<(local-command-stdout|local-command-caveat)/.test(text)) return;
    this.transition("thinking", ts);
  }

  /**
   * Closed segments plus the open one, clipped to the window ending at `now`.
   * `openState`/`openSince` let the caller override the live state with information the
   * transcript does not have (e.g. the session file says idle, so a pending tool is blocked).
   */
  timeline(now: number, openState?: TimelineState, openSince?: number): TimelineSegment[] {
    const cutoff = now - this.opts.windowMs;
    const raw: TimelineSegment[] = [...this.segments];
    if (this.stateSince > 0) {
      const state = openState ?? this.state;
      let since = this.stateSince;
      if (
        openState !== undefined &&
        openState !== this.state &&
        openSince !== undefined &&
        openSince > this.stateSince &&
        openSince < now
      ) {
        raw.push({ state: this.state, start: this.stateSince, end: openSince });
        since = openSince;
      }
      raw.push({ state, start: since, end: now });
    }
    return raw
      .map((s) => ({ ...s, start: Math.max(s.start, cutoff), end: Math.min(s.end, now) }))
      .filter((s) => s.end > s.start);
  }
}

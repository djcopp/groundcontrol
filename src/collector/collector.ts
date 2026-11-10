import { readdir, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  Agent,
  AgentState,
  CodeTrace,
  ProcessNode,
  Snapshot,
  TimelineState,
  TraceResponse,
} from "../shared/types.js";
import { ancestorPids, classify, resolveScript } from "./ancestry.js";
import { traceCode } from "./codeTrace.js";
import { gitInfo } from "./git.js";
import { getCwds, isClaudeAgent, listProcesses, type RawProcess } from "./processes.js";
import {
  encodeProjectDir,
  guessEntrypoint,
  readSessionFiles,
  type SessionFile,
  sessionIdFromArgs,
} from "./sessions.js";
import { TranscriptTracker } from "./transcript.js";

export interface CollectorOptions {
  claudeDir: string;
  /** Timeline window. */
  windowMs: number;
  /** Include tool-call summaries (commands, file names). */
  details: boolean;
  /** How long an exited agent stays on screen. */
  endedTtlMs: number;
  /** How long a finished subagent stays on screen. */
  doneSubagentTtlMs: number;
}

export const DEFAULT_OPTIONS: Omit<CollectorOptions, "claudeDir"> = {
  windowMs: 30 * 60_000,
  details: true,
  endedTtlMs: 3 * 60_000,
  doneSubagentTtlMs: 10 * 60_000,
};

/** Tools that finish in milliseconds unless the user is being asked for permission. */
const INSTANT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools that run as child processes of the agent. */
const SUBPROCESS_TOOLS = new Set(["Bash"]);
const BLOCKED_AFTER_MS = 6_000;
const SESSION_START_TOLERANCE_MS = 120_000;
const CWD_TTL_MS = 15_000;

interface LiveState {
  state: AgentState;
  since: number;
  /** Timeline override for the open segment. */
  timelineState?: TimelineState;
}

/**
 * Work out what an agent is doing from its transcript, its session file and its child processes.
 * Exported for tests.
 */
export function deriveState(args: {
  tracker?: Pick<TranscriptTracker, "pending" | "state" | "stateSince">;
  session?: Pick<SessionFile, "status" | "statusUpdatedAt">;
  cpu: number;
  now: number;
  /** Start times of the agent's child processes. */
  childStarts: number[];
}): LiveState {
  const { tracker, session, cpu, now, childStarts } = args;
  const status = session?.status;
  if (tracker && tracker.pending.size > 0) {
    const oldest = [...tracker.pending.values()].reduce((a, b) =>
      a.startedAt <= b.startedAt ? a : b,
    );
    if (status === "idle")
      return { state: "blocked", since: oldest.startedAt, timelineState: "blocked" };
    const age = now - oldest.startedAt;
    if (age > BLOCKED_AFTER_MS) {
      const instant = [...tracker.pending.values()].every((t) => INSTANT_TOOLS.has(t.name));
      const subprocess = [...tracker.pending.values()].every((t) => SUBPROCESS_TOOLS.has(t.name));
      const spawned = childStarts.some((s) => s >= oldest.startedAt - 1500);
      if (instant || (subprocess && !spawned && cpu < 5)) {
        return {
          state: "blocked",
          since: oldest.startedAt + BLOCKED_AFTER_MS,
          timelineState: "blocked",
        };
      }
    }
    return { state: "tool", since: oldest.startedAt };
  }
  if (status === "busy") {
    return {
      state: "thinking",
      since: tracker?.state === "thinking" ? tracker.stateSince : (session?.statusUpdatedAt ?? now),
      timelineState: "thinking",
    };
  }
  if (status === "idle") {
    const since = Math.max(tracker?.stateSince ?? 0, session?.statusUpdatedAt ?? 0) || now;
    return { state: "waiting", since, timelineState: "waiting" };
  }
  if (tracker && tracker.stateSince > 0) return { state: tracker.state, since: tracker.stateSince };
  return { state: cpu > 3 ? "thinking" : "unknown", since: now };
}

export class Collector {
  private readonly opts: CollectorOptions;
  private trackers = new Map<string, TranscriptTracker>();
  private cwdCache = new Map<number, { cwd?: string; at: number }>();
  private transcriptPaths = new Map<string, { path?: string; at: number }>();
  private ended = new Map<string, { agent: Agent; endedAt: number }>();
  private previous = new Map<string, Agent>();
  private lastSnapshot: Snapshot | undefined;

  constructor(opts: CollectorOptions) {
    this.opts = opts;
  }

  private tracker(path: string): TranscriptTracker {
    let t = this.trackers.get(path);
    if (!t) {
      t = new TranscriptTracker(path, { details: this.opts.details, windowMs: this.opts.windowMs });
      this.trackers.set(path, t);
    }
    return t;
  }

  private async cwds(pids: number[], now: number): Promise<Map<number, string>> {
    const stale = pids.filter((p) => {
      const c = this.cwdCache.get(p);
      return !c || now - c.at > CWD_TTL_MS;
    });
    if (stale.length) {
      const fresh = await getCwds(stale);
      for (const p of stale) this.cwdCache.set(p, { cwd: fresh.get(p), at: now });
    }
    const out = new Map<number, string>();
    for (const p of pids) {
      const c = this.cwdCache.get(p)?.cwd;
      if (c) out.set(p, c);
    }
    return out;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  /** Locate `<sessionId>.jsonl`, first under the cwd's project dir, then anywhere. */
  private async findTranscript(sessionId: string, cwd: string | undefined, now: number) {
    const hit = this.transcriptPaths.get(sessionId);
    if (hit?.path) return hit.path;
    if (hit && now - hit.at < 15_000) return undefined;
    const projects = join(this.opts.claudeDir, "projects");
    let found: string | undefined;
    if (cwd) {
      const p = join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`);
      if (await this.exists(p)) found = p;
    }
    if (!found) {
      try {
        for (const d of await readdir(projects)) {
          const p = join(projects, d, `${sessionId}.jsonl`);
          if (await this.exists(p)) {
            found = p;
            break;
          }
        }
      } catch {
        // no projects dir
      }
    }
    this.transcriptPaths.set(sessionId, { path: found, at: now });
    return found;
  }

  /**
   * Headless agents (`claude -p`, SDK) may have no session file. Match each to the transcript in
   * its project dir that was created closest to (and after) the process start.
   */
  private async guessTranscripts(
    agents: { pid: number; cwd?: string; startedAt: number }[],
    taken: Set<string>,
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const byDir = new Map<string, typeof agents>();
    for (const a of agents) {
      if (!a.cwd) continue;
      const dir = join(this.opts.claudeDir, "projects", encodeProjectDir(a.cwd));
      byDir.set(dir, [...(byDir.get(dir) ?? []), a]);
    }
    for (const [dir, group] of byDir) {
      let files: { path: string; born: number; mtime: number }[] = [];
      try {
        const minStart = Math.min(...group.map((g) => g.startedAt)) - 5_000;
        const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
        const stats = await Promise.all(
          names.map(async (n) => {
            const path = join(dir, n);
            try {
              const st = await stat(path);
              return { path, born: st.birthtimeMs || st.ctimeMs, mtime: st.mtimeMs };
            } catch {
              return undefined;
            }
          }),
        );
        files = stats.filter((f): f is NonNullable<typeof f> => !!f && f.mtime >= minStart);
      } catch {
        continue;
      }
      const sorted = [...group].sort((a, b) => b.startedAt - a.startedAt);
      for (const a of sorted) {
        let best: { path: string; d: number } | undefined;
        for (const f of files) {
          if (taken.has(f.path)) continue;
          const d = f.born - a.startedAt;
          if (d < -5_000) continue;
          if (!best || d < best.d) best = { path: f.path, d };
        }
        if (best) {
          out.set(a.pid, best.path);
          taken.add(best.path);
        }
      }
    }
    return out;
  }

  private processNode(p: RawProcess, cwd: string | undefined, now: number): ProcessNode {
    const c = classify(p);
    return {
      pid: p.pid,
      ppid: p.ppid,
      kind: c.kind,
      label: c.label,
      exe: p.comm,
      command: p.command.length > 600 ? `${p.command.slice(0, 600)}…` : p.command,
      cwd,
      script: c.kind === "script" ? resolveScript(c.script, cwd) : undefined,
      cpu: p.cpu,
      rssMb: Math.round(p.rssKb / 1024),
      startedAt: now - p.elapsedSec * 1000,
    };
  }

  async snapshot(): Promise<Snapshot> {
    const now = Date.now();
    const warnings: string[] = [];
    const procs = await listProcesses();
    const sessions = await readSessionFiles(this.opts.claudeDir);
    const agentProcs = [...procs.values()].filter((p) => isClaudeAgent(p));
    const agentPids = new Set(agentProcs.map((p) => p.pid));

    // Launch chains
    const chains = new Map<number, number[]>();
    const chainPids = new Set<number>();
    for (const a of agentProcs) {
      const chain = ancestorPids(a.pid, procs);
      chains.set(a.pid, chain);
      for (const pid of chain) chainPids.add(pid);
    }
    const scriptPids = [...chainPids].filter((pid) => {
      const p = procs.get(pid);
      return p && classify(p).kind === "script";
    });
    const cwds = await this.cwds([...agentPids, ...scriptPids], now);

    const processes: Record<string, ProcessNode> = {};
    for (const pid of new Set([...agentPids, ...chainPids])) {
      const p = procs.get(pid);
      if (p) processes[pid] = this.processNode(p, cwds.get(pid), now);
    }

    // Children of each agent, for "is the Bash tool actually running" checks.
    const childStarts = new Map<number, number[]>();
    for (const p of procs.values()) {
      if (agentPids.has(p.ppid)) {
        const list = childStarts.get(p.ppid) ?? [];
        list.push(now - p.elapsedSec * 1000);
        childStarts.set(p.ppid, list);
      }
    }

    // Resolve sessions -> transcripts
    const resolved = new Map<number, { session?: SessionFile; path?: string; cwd?: string }>();
    const unresolved: { pid: number; cwd?: string; startedAt: number }[] = [];
    const taken = new Set<string>();
    for (const a of agentProcs) {
      const startedAt = now - a.elapsedSec * 1000;
      let session = sessions.get(a.pid);
      // A session can start long after its process (the desktop app pre-spawns spare processes),
      // but never before it: that means the file is stale and the pid was recycled.
      if (session?.startedAt && session.startedAt < startedAt - SESSION_START_TOLERANCE_MS) {
        session = undefined;
      }
      const cwd = session?.cwd ?? cwds.get(a.pid);
      const sessionId = session?.sessionId ?? sessionIdFromArgs(a.command);
      const path = sessionId ? await this.findTranscript(sessionId, cwd, now) : undefined;
      if (path) taken.add(path);
      resolved.set(a.pid, { session, path, cwd });
      if (!path) unresolved.push({ pid: a.pid, cwd, startedAt });
    }
    if (unresolved.length) {
      const guesses = await this.guessTranscripts(unresolved, taken);
      for (const [pid, path] of guesses) {
        const r = resolved.get(pid);
        if (r) r.path = path;
      }
    }

    const agents: Agent[] = [];
    const liveTrackers = new Set<string>();
    for (const a of agentProcs) {
      const r = resolved.get(a.pid) ?? {};
      let tracker: TranscriptTracker | undefined;
      if (r.path) {
        tracker = this.tracker(r.path);
        liveTrackers.add(r.path);
        if (!(await tracker.update())) tracker = undefined;
      }
      const live = deriveState({
        tracker,
        session: r.session,
        cpu: a.cpu,
        now,
        childStarts: childStarts.get(a.pid) ?? [],
      });
      const cwd = r.cwd ?? tracker?.cwd;
      const chain = chains.get(a.pid) ?? [];
      const outer = chain.find((pid) => agentPids.has(pid));
      const id = `pid:${a.pid}`;
      const pending = tracker ? [...tracker.pending.values()] : [];
      const sessionId = r.session?.sessionId ?? (r.path ? basename(r.path, ".jsonl") : undefined);
      const agent: Agent = {
        id,
        kind: "agent",
        pid: a.pid,
        parentAgentId: outer ? `pid:${outer}` : undefined,
        name: r.session?.name ?? tracker?.title ?? (cwd ? basename(cwd) : `claude ${a.pid}`),
        sessionId,
        cwd,
        project: cwd ? basename(cwd) : undefined,
        git: cwd ? await gitInfo(cwd) : undefined,
        entrypoint: guessEntrypoint(a.command, r.session),
        model: tracker?.model ?? a.command.match(/--model[= ](\S+)/)?.[1],
        state: live.state,
        stateSince: live.since,
        currentTool: pending[pending.length - 1],
        lastActivityAt: tracker?.lastActivityAt,
        startedAt: now - a.elapsedSec * 1000,
        cpu: a.cpu,
        rssMb: Math.round(a.rssKb / 1024),
        tokens: tracker ? { ...tracker.tokens } : { input: 0, output: 0, cacheRead: 0 },
        recentTools: tracker ? tracker.recentTools.slice(-12).map((t) => ({ ...t })) : [],
        timeline: tracker
          ? tracker.timeline(now, live.timelineState, live.timelineState ? live.since : undefined)
          : [],
        ancestry: chain,
        toolCount: tracker?.toolCount ?? 0,
      };
      agents.push(agent);
      if (tracker && r.path && sessionId) {
        agents.push(
          ...(await this.subagents(agent, tracker, r.path, sessionId, now, liveTrackers)),
        );
      }
    }
    if (!agentProcs.length && !(await this.dirExists(this.opts.claudeDir))) {
      warnings.push(`No Claude config directory at ${this.opts.claudeDir}. Set --claude-dir.`);
    }

    // Agents that disappeared since the last tick linger as "ended".
    const currentIds = new Set(agents.map((a) => a.id));
    for (const [id, prev] of this.previous) {
      if (!currentIds.has(id) && prev.kind === "agent" && !this.ended.has(id)) {
        this.ended.set(id, {
          agent: { ...prev, state: "ended", stateSince: now, ended: true, cpu: 0 },
          endedAt: now,
        });
      }
    }
    for (const [id, e] of this.ended) {
      if (currentIds.has(id) || now - e.endedAt > this.opts.endedTtlMs) this.ended.delete(id);
      else {
        agents.push(e.agent);
        for (const pid of e.agent.ancestry) {
          const prevNode = this.lastSnapshot?.processes[pid];
          if (!processes[pid] && prevNode) processes[pid] = prevNode;
        }
        if (e.agent.pid && !processes[e.agent.pid]) {
          const prevNode = this.lastSnapshot?.processes[e.agent.pid];
          if (prevNode) processes[e.agent.pid] = prevNode;
        }
      }
    }
    this.previous = new Map(agents.filter((a) => !a.ended).map((a) => [a.id, a]));
    for (const path of this.trackers.keys())
      if (!liveTrackers.has(path)) this.trackers.delete(path);

    const snap: Snapshot = {
      generatedAt: now,
      mode: "live",
      host: hostname(),
      platform: process.platform,
      windowMs: this.opts.windowMs,
      agents,
      processes,
      warnings,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  private async dirExists(p: string) {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  private async subagents(
    parent: Agent,
    parentTracker: TranscriptTracker,
    transcriptPath: string,
    sessionId: string,
    now: number,
    liveTrackers: Set<string>,
  ): Promise<Agent[]> {
    const dir = join(dirname(transcriptPath), sessionId, "subagents");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Agent[] = [];
    const trackersById = new Map<string, TranscriptTracker>();
    const metas = new Map<string, Record<string, unknown>>();
    for (const n of names) {
      const m = n.match(/^agent-([\w-]+)\.jsonl$/);
      if (!m?.[1]) continue;
      const agentId = m[1];
      const path = join(dir, n);
      let mtime: number;
      try {
        mtime = (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), "utf8"));
      } catch {
        // meta is optional
      }
      const finished = meta.finished === true;
      const ttl = finished ? this.opts.doneSubagentTtlMs : 60 * 60_000;
      if (now - mtime > ttl) continue;
      const t = this.tracker(path);
      liveTrackers.add(path);
      if (!(await t.update())) continue;
      trackersById.set(agentId, t);
      metas.set(agentId, meta);
    }
    for (const [agentId, t] of trackersById) {
      const meta = metas.get(agentId) ?? {};
      const finished = meta.finished === true || t.handedBack;
      const toolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : undefined;
      let parentAgentId = parent.id;
      if (toolUseId && !parentTracker.agentToolIds.has(toolUseId)) {
        for (const [otherId, other] of trackersById) {
          if (other.agentToolIds.has(toolUseId)) parentAgentId = `sub:${sessionId}:${otherId}`;
        }
      }
      const pending = [...t.pending.values()];
      let state: AgentState;
      let since = t.stateSince || now;
      const quietFor = now - (t.lastActivityAt ?? 0);
      if (finished || parent.ended) state = "done";
      else if (pending.length > 0) state = "tool";
      else if (t.state === "waiting" || t.state === "done" || quietFor > 5 * 60_000) state = "done";
      else state = "thinking";
      if (state === "done") since = t.lastActivityAt ?? since;
      const description = typeof meta.description === "string" ? meta.description : undefined;
      const agentType = typeof meta.agentType === "string" ? meta.agentType : undefined;
      out.push({
        id: `sub:${sessionId}:${agentId}`,
        kind: "subagent",
        parentAgentId,
        name: description ?? agentType ?? `subagent ${agentId.slice(0, 6)}`,
        sessionId,
        cwd: parent.cwd,
        project: parent.project,
        git: parent.git,
        entrypoint: typeof meta.requestShape === "string" ? meta.requestShape : "subagent",
        agentType,
        model: t.model ?? (typeof meta.model === "string" ? meta.model : undefined),
        state,
        stateSince: since,
        currentTool: pending[pending.length - 1],
        lastActivityAt: t.lastActivityAt,
        startedAt: t.firstActivityAt,
        cpu: 0,
        rssMb: 0,
        tokens: { ...t.tokens },
        recentTools: t.recentTools.slice(-12).map((x) => ({ ...x })),
        timeline: t.timeline(
          now,
          state === "done" ? "done" : undefined,
          state === "done" ? since : undefined,
        ),
        ancestry: parent.ancestry,
        toolCount: t.toolCount,
      });
    }
    return out;
  }

  /** Launch chain + code that starts the agent. Only works for agents in the last snapshot. */
  async trace(agentId: string): Promise<TraceResponse | undefined> {
    const snap = this.lastSnapshot;
    const agent = snap?.agents.find((a) => a.id === agentId);
    if (!snap || !agent) return undefined;
    const chain: ProcessNode[] = [];
    const self = agent.pid ? snap.processes[agent.pid] : undefined;
    if (self) chain.push(self);
    for (const pid of agent.ancestry) {
      const n = snap.processes[pid];
      if (n) chain.push(n);
    }
    let code: CodeTrace[] = [];
    try {
      code = await traceCode(chain);
    } catch {
      code = [];
    }
    return { agentId, chain, code };
  }
}

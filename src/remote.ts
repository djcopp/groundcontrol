import { type ChildProcess, spawn } from "node:child_process";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import type { Source } from "./server.js";
import {
  type Agent,
  type HostStatus,
  type ProcessNode,
  procKey,
  type Snapshot,
  type TraceResponse,
} from "./shared/types.js";

/**
 * Remote machines are watched over a plain SSH session: we run `groundcontrol --stream` on the
 * host and read newline-delimited JSON from its stdout. Nothing listens on a port on either side,
 * and SSH auth, jump hosts and aliases all come from the user's own ~/.ssh/config.
 *
 * Wire protocol (one JSON object per line):
 *   remote -> local  {"type":"snapshot","data":Snapshot}
 *   local -> remote  {"type":"trace","reqId":"1","id":"pid:123"}
 *   remote -> local  {"type":"trace","reqId":"1","data":TraceResponse|null}
 */
export type StreamMessage =
  | { type: "snapshot"; data: Snapshot }
  | { type: "trace"; reqId: string; data: TraceResponse | null };

export interface RemoteOptions {
  /** ssh target: "devbox", "me@10.0.0.5", any Host alias from ~/.ssh/config. */
  target: string;
  /** Command run on the remote host. */
  remoteCommand: string;
  /** Local ssh client, split on spaces: "ssh", "tsh ssh", "gcloud compute ssh --zone x"... */
  ssh: string;
  /** Wait before reconnecting after the session drops (grows to 30 s). */
  retryMs?: number;
}

const SSH_OPTS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ConnectTimeout=10",
];

export class RemoteHost {
  readonly name: string;
  private readonly opts: RemoteOptions;
  private child: ChildProcess | undefined;
  private latest: Snapshot | undefined;
  private latestAt: number | undefined;
  private status: HostStatus["status"] = "connecting";
  private message: string | undefined;
  private stderrTail: string[] = [];
  private retry: number;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private reqSeq = 0;
  private pending = new Map<string, (t: TraceResponse | null) => void>();

  constructor(opts: RemoteOptions) {
    this.opts = opts;
    this.name = opts.target;
    this.retry = opts.retryMs ?? 2000;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  private connect() {
    const [cmd, ...pre] = this.opts.ssh.split(/\s+/).filter(Boolean);
    if (!cmd) throw new Error("empty --ssh command");
    const isPlainSsh = /(^|\/)ssh$/.test(cmd) && pre.length === 0;
    const args = [
      ...pre,
      ...(isPlainSsh ? SSH_OPTS : []),
      this.opts.target,
      this.opts.remoteCommand,
    ];
    this.status = this.latest ? this.status : "connecting";
    this.stderrTail = [];
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      const clean = line.trim();
      if (!clean) return;
      this.stderrTail.push(clean);
      if (this.stderrTail.length > 5) this.stderrTail.shift();
    });
    child.on("error", (err) => {
      this.status = "error";
      this.message = `${cmd}: ${err.message}`;
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
      if (this.stopped) return;
      this.status = "error";
      this.message =
        this.stderrTail[this.stderrTail.length - 1] ??
        this.message ??
        `session ended (exit ${code ?? "signal"})`;
      this.retryTimer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    });
  }

  private onLine(line: string) {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(line) as StreamMessage;
    } catch {
      return; // MOTD, shell noise, npx progress...
    }
    if (msg.type === "snapshot" && msg.data && Array.isArray(msg.data.agents)) {
      this.latest = msg.data;
      this.latestAt = Date.now();
      this.status = "live";
      this.message = undefined;
      this.retry = this.opts.retryMs ?? 2000;
    } else if (msg.type === "trace") {
      this.pending.get(msg.reqId)?.(msg.data);
      this.pending.delete(msg.reqId);
    }
  }

  hostStatus(): HostStatus {
    const stale = this.latestAt !== undefined && Date.now() - this.latestAt > 15_000;
    return {
      name: this.name,
      label: this.name,
      local: false,
      status: stale && this.status === "live" ? "connecting" : this.status,
      message: stale && this.status === "live" ? "no data for 15 s" : this.message,
      lastSnapshotAt: this.latestAt,
    };
  }

  /** The remote's latest snapshot, namespaced so its ids and pids cannot clash with ours. */
  snapshot(): Snapshot | undefined {
    return this.latest ? namespaceSnapshot(this.latest, this.name) : undefined;
  }

  trace(remoteAgentId: string, timeoutMs = 10_000): Promise<TraceResponse | null> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.resolve(null);
    const reqId = String(++this.reqSeq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(reqId, (t) => {
        clearTimeout(timer);
        resolve(t);
      });
      child.stdin?.write(`${JSON.stringify({ type: "trace", reqId, id: remoteAgentId })}\n`);
    });
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.child?.kill();
    this.child = undefined;
  }
}

const nsId = (host: string, id: string) => `${host}/${id}`;

/** Prefix agent ids and process keys with the host, and tag everything with it. */
export function namespaceSnapshot(snap: Snapshot, host: string): Snapshot {
  const processes: Record<string, ProcessNode> = {};
  for (const p of Object.values(snap.processes)) processes[procKey(host, p.pid)] = { ...p, host };
  const agents: Agent[] = snap.agents.map((a) => ({
    ...a,
    id: nsId(host, a.id),
    parentAgentId: a.parentAgentId ? nsId(host, a.parentAgentId) : undefined,
    host,
  }));
  return { ...snap, agents, processes };
}

/** Merges this machine's collector (optional) with any number of SSH hosts. */
export class MultiSource implements Source {
  private readonly local: Source | undefined;
  private readonly remotes: RemoteHost[];

  constructor(local: Source | undefined, remotes: RemoteHost[]) {
    this.local = local;
    this.remotes = remotes;
  }

  start() {
    for (const r of this.remotes) r.start();
  }

  stop() {
    for (const r of this.remotes) r.stop();
  }

  async snapshot(): Promise<Snapshot> {
    const now = Date.now();
    const base: Snapshot = this.local
      ? await this.local.snapshot()
      : {
          generatedAt: now,
          mode: "live",
          host: hostname(),
          platform: process.platform,
          windowMs: 30 * 60_000,
          agents: [],
          processes: {},
          warnings: [],
        };
    const hosts: HostStatus[] = this.local
      ? [{ name: "local", label: base.host, local: true, status: "live", lastSnapshotAt: now }]
      : [];
    const agents = [...base.agents];
    const processes = { ...base.processes };
    const warnings = [...base.warnings];
    for (const r of this.remotes) {
      const status = r.hostStatus();
      hosts.push(status);
      const snap = r.snapshot();
      if (snap) {
        // Re-anchor remote timestamps onto our clock so durations are not skewed by clock drift.
        const skew = (status.lastSnapshotAt ?? now) - snap.generatedAt;
        agents.push(...snap.agents.map((a) => shiftAgent(a, skew)));
        Object.assign(processes, snap.processes);
      }
      if (status.status === "error" && status.message)
        warnings.push(`${r.name}: ${status.message}`);
    }
    return { ...base, generatedAt: now, agents, processes, hosts, warnings };
  }

  async trace(agentId: string): Promise<TraceResponse | undefined> {
    for (const r of this.remotes) {
      const prefix = `${r.name}/`;
      if (!agentId.startsWith(prefix)) continue;
      const t = await r.trace(agentId.slice(prefix.length));
      if (!t) return undefined;
      return {
        agentId,
        chain: t.chain.map((p) => ({ ...p, host: r.name })),
        code: t.code,
      };
    }
    return this.local?.trace(agentId);
  }
}

function shiftAgent(a: Agent, skew: number): Agent {
  if (!skew) return a;
  const s = (t: number | undefined) => (t === undefined ? undefined : t + skew);
  return {
    ...a,
    stateSince: a.stateSince + skew,
    lastActivityAt: s(a.lastActivityAt),
    startedAt: s(a.startedAt),
    currentTool: a.currentTool
      ? {
          ...a.currentTool,
          startedAt: a.currentTool.startedAt + skew,
          endedAt: s(a.currentTool.endedAt),
        }
      : undefined,
    recentTools: a.recentTools.map((t) => ({
      ...t,
      startedAt: t.startedAt + skew,
      endedAt: s(t.endedAt),
    })),
    timeline: a.timeline.map((seg) => ({ ...seg, start: seg.start + skew, end: seg.end + skew })),
  };
}

/**
 * `--stream`: the remote end. Prints a snapshot per interval and answers trace requests on stdin.
 * Exits when stdin closes, so a dropped SSH session never leaves a collector running on the server.
 */
export function runStream(source: Source, intervalMs: number): void {
  const out = (m: StreamMessage) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      out({ type: "snapshot", data: await source.snapshot() });
    } catch (err) {
      process.stderr.write(`groundcontrol: ${String(err)}\n`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    try {
      const req = JSON.parse(line) as { type?: string; reqId?: string; id?: string };
      if (req.type === "trace" && req.reqId && req.id) {
        out({ type: "trace", reqId: req.reqId, data: (await source.trace(req.id)) ?? null });
      }
    } catch {
      // ignore malformed requests
    }
  });
  rl.on("close", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

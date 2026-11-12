import type {
  Agent,
  AgentState,
  ProcessKind,
  ProcessNode,
  Snapshot,
  TimelineSegment,
  TimelineState,
  ToolEvent,
  TraceResponse,
} from "./shared/types.js";

/**
 * Synthetic agents for `--demo`: lets people (and screenshots) see the visualiser without running
 * a fleet of agents. Everything is derived deterministically from a seed and the clock.
 */

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

type Profile = "busy" | "waity" | "blocker" | "headless" | "sub";

const TOOLS: [string, string][] = [
  ["Bash", "pnpm test"],
  ["Bash", "uv run pytest -q"],
  ["Read", "src/server/routes.ts"],
  ["Edit", "src/model/train.py"],
  ["Grep", "def forward"],
  ["Glob", "**/*.tsx"],
  ["Bash", "git diff --stat"],
  ["WebFetch", "docs.python.org"],
  ["Write", "tests/test_loader.py"],
  ["Bash", "docker compose up -d db"],
  ["Read", "README.md"],
  ["mcp__github__list_prs", "open PRs"],
  ["Agent", "Explore the auth module"],
];

interface Seg extends TimelineSegment {
  tool?: [string, string];
}

/** Contiguous segments from `from` until past `to`, drawn from the profile's rhythm. */
function schedule(seed: number, profile: Profile, from: number, to: number): Seg[] {
  const r = rng(seed);
  const segs: Seg[] = [];
  let t = from;
  const between = (a: number, b: number) => (a + r() * (b - a)) * 1000;
  let phase = 0;
  while (t < to) {
    let state: TimelineState;
    let len: number;
    phase++;
    switch (profile) {
      case "busy":
        if (phase % 9 === 0) [state, len] = ["waiting", between(20, 90)];
        else if (phase % 2) [state, len] = ["thinking", between(3, 14)];
        else [state, len] = ["tool", between(2, 18)];
        break;
      case "waity":
        if (phase % 5 === 0) [state, len] = ["waiting", between(120, 400)];
        else if (phase % 2) [state, len] = ["thinking", between(4, 10)];
        else [state, len] = ["tool", between(1, 6)];
        break;
      case "blocker":
        if (phase % 7 === 0) [state, len] = ["blocked", between(40, 160)];
        else if (phase % 11 === 0) [state, len] = ["waiting", between(30, 100)];
        else if (phase % 2) [state, len] = ["thinking", between(3, 12)];
        else [state, len] = ["tool", between(2, 12)];
        break;
      case "headless":
      case "sub":
        if (phase % 2) [state, len] = ["thinking", between(2, 8)];
        else [state, len] = ["tool", between(1, 9)];
        break;
    }
    const seg: Seg = { state, start: t, end: t + len };
    if (state === "tool" || state === "blocked") {
      const pick = TOOLS[Math.floor(r() * TOOLS.length)] ?? TOOLS[0];
      seg.tool = state === "blocked" ? ["Bash", "rm -rf build && make release"] : pick;
    }
    segs.push(seg);
    t += len;
  }
  return segs;
}

interface DemoAgentSpec {
  key: string;
  name: string;
  project: string;
  branch: string;
  profile: Profile;
  parentPid: number;
  entrypoint: string;
  model: string;
  /** Headless agents live for a while, exit, and get replaced. */
  lifetimeSec?: number;
  subagents?: { key: string; name: string; type: string }[];
}

const HOME = "/Users/you";
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;

const PROCS: Omit<ProcessNode, "cpu" | "rssMb">[] = [
  {
    pid: 1,
    ppid: 0,
    kind: "init",
    label: "launchd",
    exe: "/sbin/launchd",
    command: "/sbin/launchd",
  },
  {
    pid: 410,
    ppid: 1,
    kind: "terminal",
    label: "iTerm2",
    exe: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
    command: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
  },
  {
    pid: 902,
    ppid: 1,
    kind: "multiplexer",
    label: "tmux",
    exe: "tmux",
    command: "tmux new -s work",
  },
  { pid: 903, ppid: 902, kind: "shell", label: "zsh", exe: "-zsh", command: "-zsh" },
  { pid: 904, ppid: 902, kind: "shell", label: "zsh", exe: "-zsh", command: "-zsh" },
  { pid: 905, ppid: 902, kind: "shell", label: "zsh", exe: "-zsh", command: "-zsh" },
  {
    pid: 1200,
    ppid: 1,
    kind: "ide",
    label: "VS Code",
    exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    command: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  },
  { pid: 1210, ppid: 1200, kind: "shell", label: "zsh", exe: "/bin/zsh", command: "/bin/zsh -il" },
  {
    pid: 1500,
    ppid: 1,
    kind: "desktop-app",
    label: "Claude Desktop",
    exe: "/Applications/Claude.app/Contents/MacOS/Claude",
    command: "/Applications/Claude.app/Contents/MacOS/Claude",
  },
  {
    pid: 1600,
    ppid: 1,
    kind: "terminal",
    label: "Ghostty",
    exe: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    command: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
  },
  { pid: 1601, ppid: 1600, kind: "shell", label: "zsh", exe: "-zsh", command: "-zsh" },
  {
    pid: 1610,
    ppid: 1601,
    kind: "script",
    label: "orchestrate.py",
    exe: "/Users/you/projects/eval-harness/.venv/bin/python3",
    command: "python3 orchestrate.py --shards 4 --model sonnet",
    cwd: `${HOME}/projects/eval-harness`,
    script: `${HOME}/projects/eval-harness/orchestrate.py`,
  },
  {
    pid: 1700,
    ppid: 1,
    kind: "other",
    label: "cron",
    exe: "/usr/sbin/cron",
    command: "/usr/sbin/cron",
  },
  {
    pid: 1701,
    ppid: 1700,
    kind: "shell",
    label: "sh",
    exe: "/bin/sh",
    command: "/bin/sh -c nightly.sh",
  },
  {
    pid: 1702,
    ppid: 1701,
    kind: "script",
    label: "nightly-triage.ts",
    exe: "/usr/local/bin/node",
    command: "node scripts/nightly-triage.ts",
    cwd: `${HOME}/projects/support-bot`,
    script: `${HOME}/projects/support-bot/scripts/nightly-triage.ts`,
  },
];

const SPECS: DemoAgentSpec[] = [
  {
    key: "api",
    name: "Fix flaky auth tests",
    project: "payments-api",
    branch: "fix/flaky-auth",
    profile: "busy",
    parentPid: 903,
    entrypoint: "cli",
    model: "claude-opus-5-5",
  },
  {
    key: "web",
    name: "Dashboard dark mode",
    project: "web-dashboard",
    branch: "feat/dark-mode",
    profile: "waity",
    parentPid: 904,
    entrypoint: "cli",
    model: "claude-sonnet-5-5",
  },
  {
    key: "infra",
    name: "Release pipeline cleanup",
    project: "infra",
    branch: "chore/release",
    profile: "blocker",
    parentPid: 905,
    entrypoint: "cli",
    model: "claude-opus-5-5",
  },
  {
    key: "ml",
    name: "Speed up data loader",
    project: "ml-pipeline",
    branch: "perf/loader",
    profile: "busy",
    parentPid: 1210,
    entrypoint: "cli",
    model: "claude-opus-5-5",
    subagents: [
      { key: "ml-a", name: "Profile the collate fn", type: "general-purpose" },
      { key: "ml-b", name: "Find all DataLoader call sites", type: "Explore" },
    ],
  },
  {
    key: "desk1",
    name: "Write launch blog post",
    project: "blog",
    branch: "main",
    profile: "waity",
    parentPid: 1500,
    entrypoint: "claude-desktop",
    model: "claude-opus-5-5",
  },
  {
    key: "desk2",
    name: "Refactor billing service",
    project: "payments-api",
    branch: "refactor/billing",
    profile: "blocker",
    parentPid: 1500,
    entrypoint: "claude-desktop",
    model: "claude-opus-5-5",
    subagents: [{ key: "desk2-a", name: "Review invoice edge cases", type: "general-purpose" }],
  },
  ...[0, 1, 2, 3].map(
    (i): DemoAgentSpec => ({
      key: `shard${i}`,
      name: `eval shard ${i + 1}/4`,
      project: "eval-harness",
      branch: "main",
      profile: "headless",
      parentPid: 1610,
      entrypoint: "sdk-py",
      model: "claude-sonnet-5-5",
      lifetimeSec: 150 + i * 70,
    }),
  ),
  {
    key: "triage",
    name: "Nightly issue triage",
    project: "support-bot",
    branch: "main",
    profile: "headless",
    parentPid: 1702,
    entrypoint: "headless (-p)",
    model: "claude-haiku-5-5",
    lifetimeSec: 420,
  },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const toAgentState = (s: TimelineState): AgentState => s;

function buildFromSegments(
  segs: Seg[],
  now: number,
  windowMs: number,
): {
  state: AgentState;
  since: number;
  timeline: TimelineSegment[];
  tools: ToolEvent[];
  current?: ToolEvent;
} {
  const past = segs.filter((s) => s.start <= now);
  const cur = past[past.length - 1];
  const timeline = past
    .filter((s) => s.end >= now - windowMs)
    .map((s) => ({
      state: s.state,
      start: Math.max(s.start, now - windowMs),
      end: Math.min(s.end, now),
    }));
  const tools: ToolEvent[] = past
    .filter((s) => s.tool)
    .slice(-12)
    .map((s, i) => ({
      id: `demo-${s.start}-${i}`,
      name: s.tool?.[0] ?? "Bash",
      summary: s.tool?.[1] ?? "",
      startedAt: s.start,
      endedAt: s.end <= now ? s.end : undefined,
      isError: hash(String(s.start)) % 17 === 0,
    }));
  const last = tools[tools.length - 1];
  const current =
    cur && (cur.state === "tool" || cur.state === "blocked") && last && !last.endedAt
      ? last
      : undefined;
  return {
    state: cur ? toAgentState(cur.state) : "unknown",
    since: cur?.start ?? now,
    timeline,
    tools,
    current,
  };
}

export class DemoSource {
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  async snapshot(): Promise<Snapshot> {
    const now = Date.now();
    const agents: Agent[] = [];
    const processes: Record<string, ProcessNode> = {};
    const jitter = (k: string, max: number) =>
      ((hash(k + Math.floor(now / 2000)) % 1000) / 1000) * max;
    for (const p of PROCS)
      processes[p.pid] = { ...p, cpu: jitter(String(p.pid), 3), rssMb: 80 + (p.pid % 300) };
    const chainOf = (pid: number) => {
      const out: number[] = [];
      let cur: number | undefined = pid;
      while (cur && cur > 0) {
        out.push(cur);
        cur = PROCS.find((p) => p.pid === cur)?.ppid;
      }
      return out;
    };

    SPECS.forEach((spec, idx) => {
      let generation = 0;
      let bornAt = T0;
      let endsAt = Number.POSITIVE_INFINITY;
      if (spec.lifetimeSec) {
        const cycle = (spec.lifetimeSec + 25) * 1000;
        const offset = idx * 37_000;
        generation = Math.floor((now - T0 - offset) / cycle);
        bornAt = T0 + offset + generation * cycle;
        endsAt = bornAt + spec.lifetimeSec * 1000;
      }
      const pid = 20_000 + idx * 100 + (generation % 100);
      const seed = hash(`${spec.key}:${generation}`);
      const segs = schedule(seed, spec.profile, bornAt, Math.min(now, endsAt) + 1000);
      const ended = now >= endsAt;
      const b = buildFromSegments(segs, Math.min(now, endsAt), this.windowMs);
      const cwd = `${HOME}/projects/${spec.project}`;
      const agentType: ProcessKind = "agent";
      processes[pid] = {
        pid,
        ppid: spec.parentPid,
        kind: agentType,
        label: "claude",
        exe: "/Users/you/.local/bin/claude",
        command:
          spec.entrypoint === "sdk-py"
            ? `claude --output-format stream-json --verbose --model ${spec.model}`
            : spec.entrypoint.startsWith("headless")
              ? `claude -p --model ${spec.model} Triage new GitHub issues`
              : "claude",
        cwd,
        cpu: b.state === "thinking" || b.state === "tool" ? 8 + jitter(spec.key, 30) : 0.3,
        rssMb: 180 + idx * 9,
        startedAt: bornAt,
      };
      const id = `pid:${pid}`;
      const tokensOut = Math.round((now - bornAt) / 40);
      agents.push({
        id,
        kind: "agent",
        pid,
        name: spec.name,
        sessionId: `demo-${spec.key}-${generation}`,
        cwd,
        project: spec.project,
        git: { root: cwd, branch: spec.branch },
        entrypoint: spec.entrypoint,
        model: spec.model,
        state: ended ? "ended" : b.state,
        stateSince: ended ? endsAt : b.since,
        currentTool: ended ? undefined : b.current,
        lastActivityAt: Math.min(now, endsAt),
        startedAt: bornAt,
        cpu: processes[pid]?.cpu ?? 0,
        rssMb: processes[pid]?.rssMb ?? 0,
        tokens: { input: tokensOut * 6, output: tokensOut, cacheRead: tokensOut * 40 },
        recentTools: b.tools,
        timeline: b.timeline,
        ancestry: chainOf(spec.parentPid),
        toolCount: b.tools.length + Math.floor((now - bornAt) / 20_000),
        ended,
      });
      if (ended) return;

      for (const [si, sub] of (spec.subagents ?? []).entries()) {
        const cycle = (200 + si * 60) * 1000;
        const subGen = Math.floor((now - T0) / cycle);
        const subBorn = T0 + subGen * cycle;
        const runFor = cycle * 0.7;
        const subSegs = schedule(
          hash(`${sub.key}:${subGen}`),
          "sub",
          subBorn,
          Math.min(now, subBorn + runFor) + 1,
        );
        const done = now > subBorn + runFor;
        const sb = buildFromSegments(subSegs, Math.min(now, subBorn + runFor), this.windowMs);
        agents.push({
          id: `sub:${spec.key}:${sub.key}:${subGen}`,
          kind: "subagent",
          parentAgentId: id,
          name: sub.name,
          sessionId: `demo-${spec.key}-${generation}`,
          cwd,
          project: spec.project,
          git: { root: cwd, branch: spec.branch },
          entrypoint: "background",
          agentType: sub.type,
          model: "claude-haiku-5-5",
          state: done ? "done" : sb.state,
          stateSince: done ? subBorn + runFor : sb.since,
          currentTool: done ? undefined : sb.current,
          lastActivityAt: Math.min(now, subBorn + runFor),
          startedAt: subBorn,
          cpu: 0,
          rssMb: 0,
          tokens: { input: 12_000, output: 3_400, cacheRead: 80_000 },
          recentTools: sb.tools,
          timeline: done
            ? [...sb.timeline, { state: "done", start: subBorn + runFor, end: now }]
            : sb.timeline,
          ancestry: chainOf(spec.parentPid),
          toolCount: sb.tools.length,
        });
      }
    });

    return {
      generatedAt: now,
      mode: "demo",
      host: "demo-host",
      platform: "darwin",
      windowMs: this.windowMs,
      agents,
      processes,
      warnings: [],
    };
  }

  async trace(agentId: string): Promise<TraceResponse | undefined> {
    const snap = await this.snapshot();
    const agent = snap.agents.find((a) => a.id === agentId);
    if (!agent) return undefined;
    const chain = [agent.pid, ...agent.ancestry]
      .map((p) => (p ? snap.processes[p] : undefined))
      .filter((p): p is ProcessNode => !!p);
    const orchestrator = chain.find((c) => c.label === "orchestrate.py");
    const triage = chain.find((c) => c.label === "nightly-triage.ts");
    const code = [];
    if (orchestrator?.script) {
      code.push({
        pid: orchestrator.pid,
        label: orchestrator.label,
        file: orchestrator.script,
        snippets: [
          {
            line: 41,
            lines: [
              { n: 38, text: "async def run_shard(shard: Shard) -> ShardResult:", hit: false },
              { n: 39, text: "    options = ClaudeAgentOptions(", hit: true },
              {
                n: 40,
                text: '        model="sonnet", cwd=REPO, allowed_tools=["Read", "Bash"],',
                hit: false,
              },
              { n: 41, text: "    )", hit: false },
              {
                n: 42,
                text: "    async for msg in query(prompt=shard.prompt, options=options):",
                hit: true,
              },
              { n: 43, text: "        shard.record(msg)", hit: false },
            ],
          },
        ],
      });
    }
    if (triage?.script) {
      code.push({
        pid: triage.pid,
        label: triage.label,
        file: triage.script,
        snippets: [
          {
            line: 12,
            lines: [
              { n: 11, text: "const issues = await listNewIssues();", hit: false },
              {
                n: 12,
                text: 'const child = spawn("claude", ["-p", "--model", "haiku", prompt(issues)]);',
                hit: true,
              },
              { n: 13, text: "child.stdout.pipe(process.stdout);", hit: false },
            ],
          },
        ],
      });
    }
    return { agentId, chain, code };
  }
}

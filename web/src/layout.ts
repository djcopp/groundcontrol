import {
  type Agent,
  type AgentState,
  type HostStatus,
  type ProcessKind,
  type ProcessNode,
  procKey,
  type Snapshot,
} from "../../src/shared/types.js";
import { flightNumber } from "./format.js";

export type NodeType = "source" | "via" | "agent" | "subagent";

export interface LNode {
  id: string;
  type: NodeType;
  label: string;
  kind: ProcessKind | "subagent" | "background" | "host";
  proc?: ProcessNode;
  /** Set on machine roots when more than one machine is watched. */
  host?: HostStatus;
  agent?: Agent;
  children: LNode[];
  parent?: LNode;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Most significant state of any agent at or below this node. */
  flow: AgentState;
  /** Agent count per state at or below this node. */
  counts: Partial<Record<AgentState, number>>;
  /** Oldest start time below this node, for stable ordering. */
  order: number;
  /** Agents only: a flight number made from the launcher and pid, e.g. VSC482. */
  flight?: string;
}

export interface Pipe {
  id: string;
  from: LNode;
  to: LNode;
  state: AgentState;
  d: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Route length in px, so planes can fly every route at the same speed. */
  length: number;
}

export interface Layout {
  nodes: LNode[];
  pipes: Pipe[];
  width: number;
  height: number;
}

export const SIZES: Record<NodeType, { w: number; h: number }> = {
  source: { w: 210, h: 90 },
  via: { w: 236, h: 80 },
  agent: { w: 336, h: 118 },
  subagent: { w: 272, h: 80 },
};

const ROW_GAP = 16;
const TREE_GAP = 34;
const COL_GAP = 120;
const PAD = 32;
const BEND = 44;

/** Process kinds that appear as nodes on the canvas. Shells and wrappers are folded into pipes. */
const VISIBLE: ReadonlySet<ProcessKind> = new Set([
  "desktop-app",
  "terminal",
  "ide",
  "multiplexer",
  "remote",
  "script",
  "other",
]);

/** Pipe drawing priority: later wins on shared trunks. */
const PRIORITY: AgentState[] = [
  "ended",
  "done",
  "unknown",
  "waiting",
  "blocked",
  "thinking",
  "tool",
];
export const priority = (s: AgentState) => PRIORITY.indexOf(s);

/** Visible launch chain from the top (source) down to the agent's direct parent. */
export function visibleChain(agent: Agent, processes: Snapshot["processes"]): ProcessNode[] {
  const chain: ProcessNode[] = [];
  for (const pid of agent.ancestry) {
    const p = processes[procKey(agent.host, pid)];
    if (!p) continue;
    if (p.kind === "agent") break; // nested agent: placed under the outer agent instead
    if (VISIBLE.has(p.kind)) chain.push(p);
  }
  chain.reverse();
  // Collapse runs of the same app (VS Code main + its helper processes, etc.): keep the topmost.
  const out: ProcessNode[] = [];
  for (const p of chain) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === p.kind && prev.label === p.label) continue;
    out.push(p);
  }
  return out;
}

function makeNode(partial: Pick<LNode, "id" | "type" | "label" | "kind"> & Partial<LNode>): LNode {
  const size = SIZES[partial.type];
  return {
    children: [],
    col: 0,
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    flow: "ended",
    counts: {},
    order: Number.POSITIVE_INFINITY,
    ...partial,
  };
}

export interface LayoutOptions {
  hideFinished?: boolean;
}

export function buildLayout(snap: Snapshot, opts: LayoutOptions = {}): Layout {
  const agents = snap.agents.filter(
    (a) => !opts.hideFinished || (a.state !== "done" && a.state !== "ended"),
  );
  const byId = new Map<string, LNode>();
  const roots: LNode[] = [];
  const agentIds = new Set(agents.map((a) => a.id));

  // Agent nodes first so nesting can find parents.
  for (const a of agents) {
    byId.set(
      a.id,
      makeNode({
        id: a.id,
        type: a.kind === "subagent" ? "subagent" : "agent",
        label: a.name,
        kind: a.kind === "subagent" ? "subagent" : "agent",
        agent: a,
        flow: a.state,
        counts: { [a.state]: 1 },
        order: a.startedAt ?? snap.generatedAt,
      }),
    );
  }

  const attach = (parent: LNode, child: LNode) => {
    if (child.parent) return;
    child.parent = parent;
    parent.children.push(child);
  };

  // With remote hosts, every machine becomes the root of its own tree.
  const hosts = snap.hosts ?? [];
  const multiHost = hosts.length > 1 || hosts.some((h) => !h.local) || agents.some((a) => a.host);
  const hostRoot = (name: string): LNode => {
    const id = `host:${name}`;
    let n = byId.get(id);
    if (!n) {
      const status = hosts.find((h) => h.name === name) ?? {
        name,
        label: name === "local" ? snap.host : name,
        local: name === "local",
        status: "live" as const,
      };
      n = makeNode({ id, type: "source", label: status.label, kind: "host", host: status });
      n.order = status.local ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      byId.set(id, n);
      roots.push(n);
    }
    return n;
  };
  if (multiHost) for (const h of hosts) hostRoot(h.name);

  for (const a of agents) {
    const node = byId.get(a.id);
    if (!node) continue;
    if (a.parentAgentId && agentIds.has(a.parentAgentId)) {
      const p = byId.get(a.parentAgentId);
      if (p && p !== node) {
        attach(p, node);
        continue;
      }
    }
    const chain = visibleChain(a, snap.processes);
    const machine = multiHost ? hostRoot(a.host ?? "local") : undefined;
    let parent: LNode | undefined = machine;
    if (chain.length === 0) {
      const rootId = `root:background${a.host ? `:${a.host}` : ""}`;
      let root = byId.get(rootId);
      if (!root) {
        root = makeNode({
          id: rootId,
          type: machine ? "via" : "source",
          label: "Background",
          kind: "background",
        });
        byId.set(rootId, root);
        if (!machine) roots.push(root);
      }
      if (machine && !root.parent) attach(machine, root);
      parent = root;
    }
    chain.forEach((p, i) => {
      const id = `proc:${procKey(p.host, p.pid)}`;
      let n = byId.get(id);
      const isRoot = i === 0 && !machine;
      if (!n) {
        n = makeNode({
          id,
          type: isRoot ? "source" : "via",
          label: p.label,
          kind: p.kind,
          proc: p,
        });
        byId.set(id, n);
        if (isRoot) roots.push(n);
      }
      if (parent && !n.parent) attach(parent, n);
      parent = n;
    });
    if (parent) attach(parent, node);
  }

  // Roll up states and ordering.
  const rollup = (n: LNode): void => {
    for (const c of n.children) {
      rollup(c);
      // Agents keep their own state on their inlet pipe; launchers show the busiest descendant.
      if (!n.agent && priority(c.flow) > priority(n.flow)) n.flow = c.flow;
      for (const [k, v] of Object.entries(c.counts)) {
        const key = k as AgentState;
        n.counts[key] = (n.counts[key] ?? 0) + (v ?? 0);
      }
      n.order = Math.min(n.order, c.order);
    }
    n.children.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  };
  for (const r of roots) rollup(r);
  roots.sort(
    (a, b) =>
      Number(!!b.host?.local) - Number(!!a.host?.local) ||
      a.label.localeCompare(b.label) ||
      a.order - b.order,
  );

  // Columns: sources at 0, intermediates by depth, top-level agents aligned in one column.
  let agentCol = 1;
  const depthWalk = (n: LNode, d: number) => {
    if (n.type === "agent" && !n.parent?.agent) agentCol = Math.max(agentCol, d);
    if (n.type === "source" || n.type === "via") for (const c of n.children) depthWalk(c, d + 1);
  };
  for (const r of roots) depthWalk(r, 0);
  const assignCols = (n: LNode, d: number) => {
    if (n.type === "source") n.col = 0;
    else if (n.type === "via") n.col = d;
    else if (n.parent?.agent) n.col = n.parent.col + 1;
    else n.col = agentCol;
    for (const c of n.children) assignCols(c, n.col + 1);
  };
  for (const r of roots) assignCols(r, 0);

  const nodes: LNode[] = [];
  const collect = (n: LNode) => {
    nodes.push(n);
    for (const c of n.children) collect(c);
  };
  for (const r of roots) collect(r);

  const colWidth: number[] = [];
  for (const n of nodes) colWidth[n.col] = Math.max(colWidth[n.col] ?? 0, n.w);
  const colX: number[] = [];
  let x = PAD;
  for (let c = 0; c < colWidth.length; c++) {
    colX[c] = x;
    x += (colWidth[c] ?? 0) + (colWidth[c] ? COL_GAP : 0);
  }
  for (const n of nodes) n.x = colX[n.col] ?? PAD;

  // Rows: leaves stack, parents centre on their children.
  const shift = (n: LNode, dy: number) => {
    n.y += dy;
    for (const c of n.children) shift(c, dy);
  };
  const place = (n: LNode, top: number): number => {
    if (n.children.length === 0) {
      n.y = top;
      return top + n.h;
    }
    let y = top;
    for (const c of n.children) y = place(c, y) + ROW_GAP;
    y -= ROW_GAP;
    const first = n.children[0];
    const last = n.children[n.children.length - 1];
    if (!first || !last) return y;
    const centre = (first.y + first.h / 2 + last.y + last.h / 2) / 2;
    n.y = centre - n.h / 2;
    if (n.y < top) {
      const dy = top - n.y;
      shift(n, dy);
      y += dy;
    }
    return Math.max(y, n.y + n.h);
  };
  let y = PAD;
  for (const r of roots) y = place(r, y) + TREE_GAP;
  const height = Math.max(y - TREE_GAP + PAD, 200);
  const width = Math.max(...nodes.map((n) => n.x + n.w), 400) + PAD;

  const pipes: Pipe[] = [];
  for (const n of nodes) {
    for (const c of n.children) {
      const x0 = n.x + n.w;
      const y0 = n.y + n.h / 2;
      const x1 = c.x;
      const y1 = c.y + c.h / 2;
      pipes.push({
        id: `${n.id}->${c.id}`,
        from: n,
        to: c,
        state: c.flow,
        d: pipePath(x0, y0, x1, y1),
        x0,
        y0,
        x1,
        y1,
        length: Math.abs(x1 - x0) + Math.abs(y1 - y0),
      });
    }
  }
  pipes.sort((a, b) => priority(a.state) - priority(b.state));
  assignFlightNumbers(nodes);
  return { nodes, pipes, width, height };
}

/**
 * Top-level agents take their prefix from the outermost launcher ("airport") above them, skipping
 * machine roots; escorts (subagents) take their parent's number plus a letter.
 */
function assignFlightNumbers(nodes: LNode[]) {
  for (const n of nodes) {
    if (!n.agent || n.parent?.agent) continue;
    let airport: LNode | undefined = n.parent;
    while (airport?.parent && airport.parent.kind !== "host") airport = airport.parent;
    n.flight = flightNumber(
      n.agent.pid,
      airport && airport.kind !== "host" ? airport.label : "Background",
    );
  }
  const letter = (k: number) => String.fromCharCode(65 + (k % 26));
  const walk = (n: LNode) => {
    const escorts = n.children.filter((c) => c.agent);
    escorts.forEach((c, k) => {
      if (n.flight) c.flight = `${n.flight}-${letter(k)}`;
      walk(c);
    });
    for (const c of n.children) if (!c.agent) walk(c);
  };
  for (const n of nodes) if (!n.parent) walk(n);
}

/** Orthogonal pipe with rounded elbows; bends close to the parent so siblings share a manifold. */
export function pipePath(x0: number, y0: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  if (Math.abs(dy) < 0.5) return `M${x0},${y0} H${x1}`;
  const bx = Math.min(x0 + BEND, (x0 + x1) / 2);
  const r = Math.min(22, Math.abs(dy) / 2, bx - x0);
  const s = Math.sign(dy);
  return [
    `M${x0},${y0}`,
    `H${bx - r}`,
    `Q${bx},${y0} ${bx},${y0 + s * r}`,
    `V${y1 - s * r}`,
    `Q${bx},${y1} ${bx + r},${y1}`,
    `H${x1}`,
  ].join(" ");
}

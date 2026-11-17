import { useMemo } from "react";
import type { AgentState, Snapshot } from "../../src/shared/types.js";
import {
  duration,
  homeRelative,
  STATE_LABEL,
  STATE_SHORT,
  shortDuration,
  shortModel,
  toolName,
} from "./format.js";
import { AppIcon } from "./icons.js";
import { buildLayout, type LNode, type Pipe } from "./layout.js";
import { MiniTimeline } from "./MiniTimeline.js";

const FLOWING: ReadonlySet<AgentState> = new Set(["thinking", "tool"]);
const COUNT_ORDER: AgentState[] = [
  "blocked",
  "waiting",
  "tool",
  "thinking",
  "unknown",
  "done",
  "ended",
];

export interface PipeViewProps {
  snapshot: Snapshot;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  focus?: AgentState;
  hideFinished: boolean;
  zoom: number;
}

export function PipeView({
  snapshot,
  selectedId,
  onSelect,
  focus,
  hideFinished,
  zoom,
}: PipeViewProps) {
  const layout = useMemo(() => buildLayout(snapshot, { hideFinished }), [snapshot, hideFinished]);
  const now = snapshot.generatedAt;
  const nodeDim = (n: LNode) =>
    focus ? (n.agent ? n.agent.state !== focus : !n.counts[focus]) : false;
  const dimmed = (x: LNode | Pipe) => nodeDim("to" in x ? x.to : x);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking empty canvas deselects; Escape does the same from the keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <div className="canvas-scroll" onClick={() => onSelect(undefined)}>
      <div
        className="canvas"
        style={{
          width: layout.width * zoom,
          height: layout.height * zoom,
        }}
      >
        <div
          className="canvas-inner"
          style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
        >
          <svg className="pipes" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3.5" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {/* Three passes so overlapping pipes merge into one manifold. */}
            <g className="layer-casing">
              {layout.pipes.map((p) => (
                <path
                  key={p.id}
                  d={p.d}
                  className={`casing s-${p.state}${dimmed(p) ? " dim" : ""}`}
                />
              ))}
            </g>
            <g className="layer-fluid">
              {layout.pipes.map((p) => (
                <path
                  key={p.id}
                  d={p.d}
                  className={`fluid s-${p.state}${dimmed(p) ? " dim" : ""}`}
                />
              ))}
            </g>
            <g className="layer-flow">
              {layout.pipes
                .filter((p) => FLOWING.has(p.state) && !dimmed(p))
                .map((p) => (
                  <path key={p.id} d={p.d} className={`flow s-${p.state}`} filter="url(#glow)" />
                ))}
            </g>
            <g className="layer-joints">
              {layout.pipes.map((p) => (
                <g key={p.id} className={`joint s-${p.state}${dimmed(p) ? " dim" : ""}`}>
                  <rect x={p.x0 - 1} y={p.y0 - 9} width={7} height={18} rx={2} />
                  <rect x={p.x1 - 6} y={p.y1 - 9} width={7} height={18} rx={2} />
                  {p.state === "blocked" && (
                    <g className="valve-shut" transform={`translate(${p.x1 - 22}, ${p.y1})`}>
                      <circle r={8} />
                      <path d="M-4.5,-4.5 L4.5,4.5" />
                    </g>
                  )}
                </g>
              ))}
            </g>
          </svg>
          {layout.nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              now={now}
              windowMs={snapshot.windowMs}
              selected={selectedId === n.id}
              dim={dimmed(n)}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function NodeCard({
  node,
  now,
  windowMs,
  selected,
  dim,
  onSelect,
}: {
  node: LNode;
  now: number;
  windowMs: number;
  selected: boolean;
  dim: boolean;
  onSelect: (id: string) => void;
}) {
  const style = { left: node.x, top: node.y, width: node.w, height: node.h };
  const cls = `card ${node.type}${selected ? " selected" : ""}${dim ? " dim" : ""}`;
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node.id);
  };

  if (node.agent) {
    const a = node.agent;
    const since = now - a.stateSince;
    const tool = a.currentTool;
    let activity: React.ReactNode;
    if (tool && (a.state === "tool" || a.state === "blocked")) {
      activity = (
        <>
          <span className="tool-name">{toolName(tool.name)}</span>
          {tool.summary && <span className="tool-summary">{tool.summary}</span>}
          <span className="tool-time">{shortDuration(now - tool.startedAt)}</span>
        </>
      );
    } else if (a.state === "waiting") {
      activity = <span className="muted">Turn finished, waiting for input</span>;
    } else if (a.state === "thinking") {
      activity = <span className="muted">Generating…</span>;
    } else if (a.state === "ended") {
      activity = <span className="muted">Process exited</span>;
    } else if (a.state === "done") {
      activity = <span className="muted">Handed back to its caller</span>;
    } else {
      activity = <span className="muted">No transcript found</span>;
    }
    const meta = [
      a.agentType,
      a.project,
      a.git?.branch ? `⎇ ${a.git.branch}` : undefined,
      shortModel(a.model),
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <button
        type="button"
        className={`${cls} s-${a.state}`}
        style={style}
        onClick={click}
        title={`${a.name}\n${STATE_LABEL[a.state]} for ${duration(since)}\n${homeRelative(a.cwd) ?? ""}`}
      >
        <span className="port in" />
        {node.children.length > 0 && <span className="port out" />}
        <div className="card-top">
          <span className="valve" aria-hidden="true">
            <span className="valve-core" />
          </span>
          <span className="title">{a.name}</span>
          <span className="badge">
            {STATE_SHORT[a.state]} <b>{shortDuration(since)}</b>
          </span>
        </div>
        <div className="meta">{meta}</div>
        <div className="activity">{activity}</div>
        {node.type === "agent" && (
          <MiniTimeline segments={a.timeline} now={now} windowMs={windowMs} live={!a.ended} />
        )}
      </button>
    );
  }

  const total = Object.values(node.counts).reduce((s, v) => s + (v ?? 0), 0);
  const agentsText = `${total} agent${total === 1 ? "" : "s"}`;
  const hostText = node.host
    ? node.host.status === "live"
      ? `${node.host.local ? "this machine" : "ssh"} · ${agentsText}`
      : node.host.status === "connecting"
        ? "connecting…"
        : (node.host.message ?? "disconnected")
    : undefined;
  const sub = hostText
    ? hostText
    : node.proc?.kind === "script"
      ? (homeRelative(node.proc.script) ?? homeRelative(node.proc.cwd) ?? node.proc.command)
      : agentsText;
  return (
    <button
      type="button"
      className={`${cls} s-${node.flow}${node.host ? ` host h-${node.host.status}` : ""}`}
      style={style}
      onClick={click}
      title={node.proc?.command}
    >
      {node.type === "via" && <span className="port in" />}
      <span className="port out" />
      <div className="card-top">
        <AppIcon
          kind={node.host?.local ? "host-local" : node.kind}
          label={node.label}
          proc={node.proc}
          size={node.type === "source" ? 30 : 26}
        />
        <span className="title">{node.label}</span>
      </div>
      <div className="meta mono">{sub}</div>
      <div className="gauge" aria-hidden="true">
        {COUNT_ORDER.map((s) =>
          node.counts[s] ? (
            <span
              key={s}
              className={`g s-${s}`}
              style={{ flexGrow: node.counts[s] }}
              title={`${node.counts[s]} ${STATE_SHORT[s]}`}
            />
          ) : null,
        )}
      </div>
    </button>
  );
}

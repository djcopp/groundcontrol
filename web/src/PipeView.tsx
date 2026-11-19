import { useEffect, useMemo, useRef } from "react";
import type { AgentState, Snapshot } from "../../src/shared/types.js";
import {
  duration,
  homeRelative,
  STATE_LABEL,
  STATE_SHORT,
  sameStatus,
  shortDuration,
  shortModel,
  toolName,
} from "./format.js";
import { AppIcon, PLANE_PATH, PlaneIcon } from "./icons.js";
import { buildLayout, type LNode, type Pipe } from "./layout.js";
import { MiniTimeline } from "./MiniTimeline.js";

/** Planes taxi along routes whose agent is working. */
const MOVING: ReadonlySet<AgentState> = new Set(["thinking", "tool"]);
/** Planes park at the end of the route, nose to the card, when the agent needs you. */
const PARKED: ReadonlySet<AgentState> = new Set(["waiting", "blocked"]);
/** px per second: thinking cruises, tool calls move briskly. */
const SPEED: Partial<Record<AgentState, number>> = { thinking: 70, tool: 120 };
const COUNT_ORDER: AgentState[] = [
  "blocked",
  "waiting",
  "tool",
  "thinking",
  "unknown",
  "done",
  "ended",
];
/** Distance from the card at which a plane holds short. */
const HOLD = 26;

export interface PipeViewProps {
  snapshot: Snapshot;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  focus?: AgentState;
  hideFinished: boolean;
  zoom: number;
  paused: boolean;
}

export function PipeView({
  snapshot,
  selectedId,
  onSelect,
  focus,
  hideFinished,
  zoom,
  paused,
}: PipeViewProps) {
  const layout = useMemo(() => buildLayout(snapshot, { hideFinished }), [snapshot, hideFinished]);
  const now = snapshot.generatedAt;
  const nodeDim = (n: LNode) => {
    if (!focus) return false;
    if (n.agent) return !sameStatus(n.agent.state, focus);
    return !Object.entries(n.counts).some(([s, c]) => c && sameStatus(s as AgentState, focus));
  };
  const dimmed = (x: LNode | Pipe) => nodeDim("to" in x ? x.to : x);

  // SMIL plane motion ignores CSS animation-play-state, so pause it through the SVG API.
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const still = paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) el.pauseAnimations();
    else el.unpauseAnimations();
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking empty canvas deselects; Escape does the same from the keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <div className="canvas-scroll" onClick={() => onSelect(undefined)}>
      <div className="canvas" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <div
          className="canvas-inner"
          style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
        >
          <svg
            ref={svg}
            className="pipes"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {/* Taxiways in passes, so shared stretches merge into one strip of tarmac. */}
            <g className="layer-edge">
              {layout.pipes.map((p) => (
                <path
                  key={p.id}
                  d={p.d}
                  className={`edge s-${p.state}${dimmed(p) ? " dim" : ""}`}
                />
              ))}
            </g>
            <g className="layer-tarmac">
              {layout.pipes.map((p) => (
                <path
                  key={p.id}
                  d={p.d}
                  className={`tarmac s-${p.state}${dimmed(p) ? " dim" : ""}`}
                />
              ))}
            </g>
            <g className="layer-centreline">
              {layout.pipes.map((p) => (
                <path
                  key={p.id}
                  d={p.d}
                  className={`centreline s-${p.state}${dimmed(p) ? " dim" : ""}`}
                  filter={MOVING.has(p.state) && !dimmed(p) ? "url(#glow)" : undefined}
                />
              ))}
            </g>
            <g className="layer-markings">
              {layout.pipes
                .filter((p) => PARKED.has(p.state))
                .map((p) => {
                  const x = p.x1 - HOLD + 12;
                  return p.state === "blocked" ? (
                    // Stop bar: a row of red lights across the taxiway.
                    <g key={p.id} className={`stopbar${dimmed(p) ? " dim" : ""}`}>
                      {[-4.5, -1.5, 1.5, 4.5].map((dy) => (
                        <circle key={dy} cx={x} cy={p.y1 + dy} r={1.3} />
                      ))}
                    </g>
                  ) : (
                    // Holding position marking: two solid and two dashed amber lines.
                    <g key={p.id} className={`holdline${dimmed(p) ? " dim" : ""}`}>
                      <line x1={x} y1={p.y1 - 5.5} x2={x} y2={p.y1 + 5.5} />
                      <line x1={x + 2.5} y1={p.y1 - 5.5} x2={x + 2.5} y2={p.y1 + 5.5} />
                      <line
                        className="dashed"
                        x1={x + 5.5}
                        y1={p.y1 - 5.5}
                        x2={x + 5.5}
                        y2={p.y1 + 5.5}
                      />
                      <line
                        className="dashed"
                        x1={x + 8}
                        y1={p.y1 - 5.5}
                        x2={x + 8}
                        y2={p.y1 + 5.5}
                      />
                    </g>
                  );
                })}
            </g>
            <g className="layer-planes">
              {layout.pipes
                .filter((p) => MOVING.has(p.state) && !dimmed(p))
                .map((p) => {
                  const dur = Math.max(1.6, p.length / (SPEED[p.state] ?? 90));
                  return (
                    <g key={p.id} className={`plane s-${p.state}`}>
                      <path d={PLANE_PATH} transform="scale(0.8)" />
                      <animateMotion
                        dur={`${dur.toFixed(2)}s`}
                        repeatCount="indefinite"
                        rotate="auto"
                        path={p.d}
                      />
                    </g>
                  );
                })}
              {layout.pipes
                .filter((p) => PARKED.has(p.state))
                .map((p) => (
                  <g
                    key={p.id}
                    className={`plane parked s-${p.state}${dimmed(p) ? " dim" : ""}`}
                    transform={`translate(${p.x1 - HOLD - 4}, ${p.y1})`}
                  >
                    <path d={PLANE_PATH} transform="scale(0.8)" />
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
      activity = <span className="muted">Turn finished, waiting for you</span>;
    } else if (a.state === "thinking") {
      activity = <span className="muted">Thinking…</span>;
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
        title={`${node.flight ?? ""} ${a.name}\n${STATE_LABEL[a.state]} for ${duration(since)}\n${homeRelative(a.cwd) ?? ""}`}
      >
        <div className="card-top">
          <span className="status-plane">
            <PlaneIcon size={16} />
          </span>
          {node.flight && <span className="flight">{node.flight}</span>}
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
  const flightsText = `${total} flight${total === 1 ? "" : "s"}`;
  const hostText = node.host
    ? node.host.status === "live"
      ? `${node.host.local ? "this machine" : "ssh"} · ${flightsText}`
      : node.host.status === "connecting"
        ? "connecting…"
        : (node.host.message ?? "disconnected")
    : undefined;
  const sub = hostText
    ? hostText
    : node.proc?.kind === "script"
      ? (homeRelative(node.proc.script) ?? homeRelative(node.proc.cwd) ?? node.proc.command)
      : flightsText;
  return (
    <button
      type="button"
      className={`${cls} s-${node.flow}${node.host ? ` host h-${node.host.status}` : ""}`}
      style={style}
      onClick={click}
      title={node.proc?.command}
    >
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

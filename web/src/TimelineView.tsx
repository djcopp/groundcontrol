import { useMemo } from "react";
import type { Agent, AgentState, ProcessNode, Snapshot } from "../../src/shared/types.js";
import { clock, duration, STATE_LABEL, STATE_SHORT, shortDuration } from "./format.js";
import { AppIcon } from "./icons.js";
import { visibleChain } from "./layout.js";

interface Group {
  key: string;
  label: string;
  kind: string;
  proc?: ProcessNode;
  agents: Agent[];
}

/** One horizontal pipe per agent over the timeline window: see who worked when, and who waited. */
export function TimelineView({
  snapshot,
  selectedId,
  onSelect,
  focus,
  hideFinished,
}: {
  snapshot: Snapshot;
  selectedId?: string;
  onSelect: (id: string) => void;
  focus?: AgentState;
  hideFinished: boolean;
}) {
  const now = snapshot.generatedAt;
  const windowMs = snapshot.windowMs;
  const start = now - windowMs;

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    const byId = new Map(snapshot.agents.map((a) => [a.id, a]));
    const topOf = (a: Agent): Agent => {
      let cur = a;
      for (let i = 0; i < 10 && cur.parentAgentId; i++) {
        const p = byId.get(cur.parentAgentId);
        if (!p) break;
        cur = p;
      }
      return cur;
    };
    const ordered = [...snapshot.agents]
      .filter((a) => !hideFinished || (a.state !== "done" && a.state !== "ended"))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    // parents before their subagents
    const rows: Agent[] = [];
    const placed = new Set<string>();
    const place = (a: Agent) => {
      if (placed.has(a.id)) return;
      placed.add(a.id);
      rows.push(a);
      for (const c of ordered) if (c.parentAgentId === a.id) place(c);
    };
    for (const a of ordered) if (!a.parentAgentId || !byId.has(a.parentAgentId)) place(a);
    for (const a of ordered) place(a);
    for (const a of rows) {
      const top = topOf(a);
      const src = visibleChain(top, snapshot.processes)[0];
      const key = src ? `proc:${src.pid}` : "background";
      const g = map.get(key) ?? {
        key,
        label: src?.label ?? "Background",
        kind: src?.kind ?? "background",
        proc: src,
        agents: [],
      };
      g.agents.push(a);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [snapshot, hideFinished]);

  const ticks = useMemo(() => {
    const step =
      windowMs <= 15 * 60_000 ? 60_000 : windowMs <= 60 * 60_000 ? 5 * 60_000 : 15 * 60_000;
    const out: number[] = [];
    for (let t = Math.ceil(start / step) * step; t <= now; t += step) out.push(t);
    return out;
  }, [start, now, windowMs]);

  const pct = (t: number) => `${((t - start) / windowMs) * 100}%`;

  return (
    <div className="timeline">
      <div className="tl-axis">
        <div className="tl-label-col">Last {Math.round(windowMs / 60_000)} min</div>
        <div className="tl-lane-col">
          {ticks.map((t) => (
            <span key={t} className="tick" style={{ left: pct(t) }}>
              {clock(t)}
            </span>
          ))}
          <span className="tick now" style={{ left: "100%" }}>
            now
          </span>
        </div>
      </div>
      {groups.map((g) => (
        <section key={g.key} className="tl-group">
          <h3>
            <AppIcon kind={g.kind} label={g.label} proc={g.proc} size={22} /> {g.label}
          </h3>
          {g.agents.map((a) => {
            const active = a.timeline.filter((s) => s.state === "thinking" || s.state === "tool");
            const activeMs = active.reduce((s, x) => s + (x.end - x.start), 0);
            const waitMs = a.timeline
              .filter((s) => s.state === "waiting" || s.state === "blocked")
              .reduce((s, x) => s + (x.end - x.start), 0);
            const dim = focus && a.state !== focus;
            return (
              <button
                type="button"
                key={a.id}
                className={`tl-row${selectedId === a.id ? " selected" : ""}${dim ? " dim" : ""}${a.kind === "subagent" ? " sub" : ""}`}
                onClick={() => onSelect(a.id)}
              >
                <div className="tl-label-col">
                  <span className={`dot s-${a.state}`} />
                  <span className="tl-name">{a.name}</span>
                  <span className="tl-state">
                    {STATE_SHORT[a.state]} {shortDuration(now - a.stateSince)}
                  </span>
                </div>
                <div className="tl-lane-col">
                  <div className="tl-lane">
                    {ticks.map((t) => (
                      <span key={t} className="grid" style={{ left: pct(t) }} />
                    ))}
                    {a.timeline.map((s, i) => (
                      <span
                        key={`${s.start}-${s.state}`}
                        className={`seg s-${s.state}${i === a.timeline.length - 1 && !a.ended ? " open" : ""}`}
                        style={{
                          left: pct(s.start),
                          width: `${Math.max(((s.end - s.start) / windowMs) * 100, 0.3)}%`,
                        }}
                        title={`${STATE_LABEL[s.state]} ${clock(s.start)}–${clock(s.end)} (${duration(s.end - s.start)})`}
                      />
                    ))}
                  </div>
                  <span className="tl-stats">
                    {shortDuration(activeMs)} active · {shortDuration(waitMs)} waiting
                  </span>
                </div>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentState, Snapshot } from "../../src/shared/types.js";
import { DetailPanel } from "./DetailPanel.js";
import { STATE_LABEL } from "./format.js";
import { Glyph, Logo, PlaneIcon } from "./icons.js";
import { PipeView } from "./PipeView.js";
import { TimelineView } from "./TimelineView.js";
import { useSnapshot } from "./useSnapshot.js";

type View = "pipes" | "timeline";

const CHIPS: { state: AgentState; label: string; hint: string }[] = [
  { state: "blocked", label: "awaiting clearance", hint: "Stuck on a permission prompt" },
  { state: "waiting", label: "holding", hint: "Turn finished, waiting for you" },
  { state: "thinking", label: "in flight", hint: "The model is thinking" },
  { state: "tool", label: "taxiing", hint: "A tool call is running" },
  { state: "done", label: "landed", hint: "Finished subagents and exited agents" },
];

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`groundcontrol:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(`groundcontrol:${key}`, JSON.stringify(next));
      } catch {
        // storage unavailable
      }
    },
    [key],
  );
  return [v, set];
}

/** Title badge + optional desktop notifications when an agent starts needing you. */
function useAttention(snapshot: Snapshot | undefined, notify: boolean) {
  const prev = useRef(new Map<string, AgentState>());
  useEffect(() => {
    if (!snapshot) return;
    const needs = snapshot.agents.filter((a) => a.state === "blocked" || a.state === "waiting");
    const blocked = needs.filter((a) => a.state === "blocked").length;
    document.title = needs.length
      ? `(${blocked ? `${blocked}! ` : ""}${needs.length}) Ground Control`
      : "Ground Control";
    if (
      notify &&
      prev.current.size &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      for (const a of snapshot.agents) {
        const before = prev.current.get(a.id);
        if (before && before !== a.state && (a.state === "blocked" || a.state === "waiting")) {
          new Notification(`${a.name}: ${STATE_LABEL[a.state].toLowerCase()}`, {
            body: [a.project, a.currentTool?.name, a.currentTool?.summary]
              .filter(Boolean)
              .join(" · "),
            tag: a.id,
            silent: a.state === "waiting",
          });
        }
      }
    }
    prev.current = new Map(snapshot.agents.map((a) => [a.id, a.state]));
  }, [snapshot, notify]);
}

export function App() {
  const { snapshot, connection, error } = useSnapshot();
  const [view, setView] = usePersisted<View>("view", "pipes");
  const [hideFinished, setHideFinished] = usePersisted("hideFinished", false);
  const [notify, setNotify] = usePersisted("notify", false);
  const [zoom, setZoom] = usePersisted("zoom", 1);
  const [paused, setPaused] = usePersisted("paused", false);
  const [selectedId, setSelectedId] = useState<string>();
  const [focus, setFocus] = useState<AgentState>();
  useAttention(snapshot, notify);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedId(undefined);
        setFocus(undefined);
      }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "t") setView(view === "pipes" ? "timeline" : "pipes");
      if (e.key === "=" || e.key === "+") setZoom(Math.min(2, +(zoom + 0.1).toFixed(2)));
      if (e.key === "-") setZoom(Math.max(0.4, +(zoom - 0.1).toFixed(2)));
      if (e.key === "0") setZoom(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, zoom, setView, setZoom]);

  const counts = useMemo(() => {
    const c: Partial<Record<AgentState, number>> = {};
    for (const a of snapshot?.agents ?? []) {
      const key = a.state === "ended" ? "done" : a.state;
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [snapshot]);

  const toggleNotify = async () => {
    if (!notify && "Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") return;
    }
    setNotify(!notify);
  };

  const live = snapshot?.agents.filter((a) => !a.ended && a.state !== "done").length ?? 0;

  return (
    <div className={`app${selectedId ? " with-panel" : ""}${paused ? " paused" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">Ground Control</span>
          {snapshot?.mode === "demo" && <span className="demo-badge">demo</span>}
        </div>
        <fieldset className="chips">
          <legend className="sr-only">Highlight agents by state</legend>
          {CHIPS.map((c) => (
            <button
              key={c.state}
              type="button"
              className={`chip s-${c.state}${focus === c.state ? " on" : ""}${counts[c.state] ? "" : " zero"}`}
              onClick={() => setFocus(focus === c.state ? undefined : c.state)}
              aria-pressed={focus === c.state}
              title={`${c.hint}. Click to highlight.`}
            >
              <span className="dot" />
              <b>{counts[c.state] ?? 0}</b> {c.label}
            </button>
          ))}
        </fieldset>
        <div className="controls">
          <div className="seg-control" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === "pipes"}
              className={view === "pipes" ? "on" : ""}
              onClick={() => setView("pipes")}
            >
              Pipes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "timeline"}
              className={view === "timeline" ? "on" : ""}
              onClick={() => setView("timeline")}
            >
              Timeline
            </button>
          </div>
          {view === "pipes" && (
            <div className="zoom">
              <button
                type="button"
                onClick={() => setZoom(Math.max(0.4, +(zoom - 0.1).toFixed(2)))}
                aria-label="Zoom out"
              >
                <Glyph name="minus" size={14} />
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="zoom-level"
                aria-label="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoom(Math.min(2, +(zoom + 0.1).toFixed(2)))}
                aria-label="Zoom in"
              >
                <Glyph name="plus" size={14} />
              </button>
            </div>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={hideFinished}
              onChange={(e) => setHideFinished(e.target.checked)}
            />
            Hide finished
          </label>
          <label className="toggle">
            <input type="checkbox" checked={notify} onChange={toggleNotify} />
            Notify me
          </label>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPaused(!paused)}
            aria-pressed={paused}
            aria-label={paused ? "Resume pipe animation" : "Pause pipe animation"}
            title={paused ? "Resume pipe animation" : "Pause pipe animation"}
          >
            <Glyph name={paused ? "play" : "pause"} size={14} />
          </button>
          <span
            className={`conn ${connection}`}
            title={snapshot ? `${snapshot.host} · ${snapshot.platform}` : ""}
          >
            <span className="conn-dot" />
            {connection === "live" ? `${live} live` : connection}
          </span>
        </div>
      </header>

      <main className="stage">
        {error && <div className="banner err">Collector error: {error}</div>}
        {snapshot?.warnings.map((w) => (
          <div key={w} className="banner">
            {w}
          </div>
        ))}
        {!snapshot ? (
          <Empty title="Connecting to the collector…" />
        ) : snapshot.agents.length === 0 ? (
          <Empty
            title="No Claude agents running"
            body={
              <>
                Start one with <code>claude</code> in any terminal and it will flow in here within a
                second. Want to see what it looks like first? Run <code>groundcontrol --demo</code>.
              </>
            }
          />
        ) : view === "pipes" ? (
          <PipeView
            paused={paused}
            snapshot={snapshot}
            selectedId={selectedId}
            onSelect={setSelectedId}
            focus={focus}
            hideFinished={hideFinished}
            zoom={zoom}
          />
        ) : (
          <TimelineView
            snapshot={snapshot}
            selectedId={selectedId}
            onSelect={setSelectedId}
            focus={focus}
            hideFinished={hideFinished}
          />
        )}
        {view === "pipes" && snapshot && snapshot.agents.length > 0 && <Legend />}
      </main>

      {selectedId && snapshot && (
        <DetailPanel id={selectedId} snapshot={snapshot} onClose={() => setSelectedId(undefined)} />
      )}
    </div>
  );
}

function Legend() {
  const items: [AgentState, string, string][] = [
    ["thinking", "in flight", "thinking"],
    ["tool", "taxiing", "running a tool"],
    ["waiting", "holding", "waiting for you"],
    ["blocked", "awaiting clearance", "needs permission"],
    ["done", "landed", "finished"],
  ];
  return (
    <div className="legend">
      {items.map(([s, term, plain]) => (
        <span key={s} className={`legend-item s-${s}`} title={plain}>
          <PlaneIcon size={15} className="legend-plane" />
          <b>{term}</b> <span className="muted">{plain}</span>
        </span>
      ))}
    </div>
  );
}

function Empty({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="empty">
      <svg width="220" height="90" viewBox="0 0 220 90" aria-hidden="true">
        <path d="M10 70H64Q86 70 86 48V42Q86 20 108 20H210" className="edge s-done" />
        <path d="M10 70H64Q86 70 86 48V42Q86 20 108 20H210" className="tarmac s-done" />
        <path d="M10 70H64Q86 70 86 48V42Q86 20 108 20H210" className="centreline s-done" />
      </svg>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
    </div>
  );
}

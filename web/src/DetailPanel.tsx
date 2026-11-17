import { useEffect, useState } from "react";
import type { Agent, ProcessNode, Snapshot, TraceResponse } from "../../src/shared/types.js";
import {
  clock,
  duration,
  homeRelative,
  STATE_LABEL,
  shortDuration,
  shortModel,
  tokens,
  toolName,
} from "./format.js";
import { AppIcon, Glyph } from "./icons.js";
import { MiniTimeline } from "./MiniTimeline.js";

function useTrace(agentId: string | undefined) {
  const [trace, setTrace] = useState<TraceResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setTrace(undefined);
    setError(undefined);
    if (!agentId) return;
    const ctrl = new AbortController();
    fetch(`/api/trace?id=${encodeURIComponent(agentId)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t: TraceResponse) => setTrace(t))
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(String(e));
      });
    return () => ctrl.abort();
  }, [agentId]);
  return { trace, error };
}

function Row({ k, v, mono }: { k: string; v?: React.ReactNode; mono?: boolean }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}

function Chain({ chain, highlightPid }: { chain: ProcessNode[]; highlightPid?: number }) {
  // chain is agent-first; show it top-down like a call stack read from the outside in.
  const topDown = [...chain].reverse();
  return (
    <ol className="chain">
      {topDown.map((p) => (
        <li key={p.pid} className={`k-${p.kind}${p.pid === highlightPid ? " hl" : ""}`}>
          <AppIcon kind={p.kind} label={p.label} proc={p} size={24} />
          <div className="chain-body">
            <div className="chain-head">
              <b>{p.label}</b>
              <span className="pid">pid {p.pid}</span>
              <span className="chain-kind">{p.kind}</span>
            </div>
            <code className="cmd" title={p.command}>
              {p.command}
            </code>
            {p.cwd && <div className="cwd mono">{homeRelative(p.cwd)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Code({ trace, onlyPid }: { trace?: TraceResponse; onlyPid?: number }) {
  const blocks = trace?.code.filter((c) => onlyPid === undefined || c.pid === onlyPid) ?? [];
  if (!trace) return <p className="muted">Tracing…</p>;
  if (blocks.length === 0)
    return (
      <p className="muted">
        No launcher script in the chain. This agent was started directly from a shell or app, so the
        launch chain above is the whole story.
      </p>
    );
  return (
    <>
      {blocks.map((b) => (
        <div key={`${b.pid}-${b.file}`} className="code-block">
          <div className="code-file mono">
            {homeRelative(b.file)}
            {b.error && <span className="err"> · {b.error}</span>}
          </div>
          {b.snippets.length === 0 && !b.error && (
            <p className="muted small">No lines mentioning claude / anthropic in this file.</p>
          )}
          {b.snippets.map((s) => (
            <pre key={s.line} className="code">
              {s.lines.map((l) => (
                <div key={l.n} className={l.hit ? "hit" : undefined}>
                  <span className="ln">{l.n}</span>
                  {l.text || " "}
                </div>
              ))}
            </pre>
          ))}
        </div>
      ))}
    </>
  );
}

function AgentDetail({ agent, snapshot }: { agent: Agent; snapshot: Snapshot }) {
  const { trace, error } = useTrace(agent.kind === "agent" ? agent.id : agent.parentAgentId);
  const now = snapshot.generatedAt;
  const subagents = snapshot.agents.filter((a) => a.parentAgentId === agent.id);
  return (
    <>
      <header className={`panel-head s-${agent.state}`}>
        <div className="panel-kicker">{agent.kind === "subagent" ? "Subagent" : "Agent"}</div>
        <h2>{agent.name}</h2>
        <div className="panel-state">
          <span className={`dot s-${agent.state}`} />
          {STATE_LABEL[agent.state]} for {duration(now - agent.stateSince)}
        </div>
        {agent.currentTool && (agent.state === "tool" || agent.state === "blocked") && (
          <div className="panel-tool">
            <b>{toolName(agent.currentTool.name)}</b> {agent.currentTool.summary}
          </div>
        )}
      </header>

      <section>
        <MiniTimeline
          segments={agent.timeline}
          now={now}
          windowMs={snapshot.windowMs}
          live={!agent.ended}
          height={12}
        />
        <div className="tl-caption">
          <span>{Math.round(snapshot.windowMs / 60_000)} min ago</span>
          <span>now</span>
        </div>
      </section>

      <section className="kvs">
        <Row k="Machine" v={agent.host ? `${agent.host} (ssh)` : undefined} mono />
        <Row k="Project" v={agent.project} />
        <Row k="Directory" v={homeRelative(agent.cwd)} mono />
        <Row
          k="Git"
          v={agent.git ? (agent.git.branch ?? `detached ${agent.git.commit ?? ""}`) : undefined}
          mono
        />
        <Row k="Started via" v={agent.entrypoint} />
        <Row k="Type" v={agent.agentType} />
        <Row k="Model" v={shortModel(agent.model)} />
        <Row k="PID" v={agent.pid} mono />
        <Row k="Session" v={agent.sessionId} mono />
        <Row k="Running for" v={agent.startedAt ? duration(now - agent.startedAt) : undefined} />
        <Row
          k="CPU / RAM"
          v={agent.pid ? `${agent.cpu.toFixed(1)}% · ${agent.rssMb} MB` : undefined}
        />
        <Row
          k="Tokens"
          v={`${tokens(agent.tokens.input)} in · ${tokens(agent.tokens.output)} out · ${tokens(agent.tokens.cacheRead)} cached`}
        />
        <Row k="Tool calls" v={agent.toolCount} />
      </section>

      {subagents.length > 0 && (
        <section>
          <h3>Subagents</h3>
          <ul className="subs">
            {subagents.map((s) => (
              <li key={s.id}>
                <span className={`dot s-${s.state}`} /> {s.name}{" "}
                <span className="muted">
                  {s.agentType} · {STATE_LABEL[s.state].toLowerCase()}{" "}
                  {shortDuration(now - s.stateSince)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Recent tool calls</h3>
        {agent.recentTools.length === 0 ? (
          <p className="muted">None in the transcript window.</p>
        ) : (
          <ul className="tools">
            {[...agent.recentTools].reverse().map((t) => (
              <li key={t.id} className={t.isError ? "error" : t.endedAt ? "" : "running"}>
                <span className="t-time">{clock(t.startedAt)}</span>
                <span className="t-name" title={t.name}>
                  {toolName(t.name)}
                </span>
                <span className="t-sum">{t.summary}</span>
                <span className="t-dur">
                  {t.endedAt ? duration(t.endedAt - t.startedAt) : "running"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Launch chain</h3>
        <p className="muted small">Where this agent was started from, outermost first.</p>
        {error && <p className="err">{error}</p>}
        {trace ? (
          <Chain chain={trace.chain} highlightPid={agent.pid} />
        ) : (
          !error && <p className="muted">Tracing…</p>
        )}
      </section>

      <section>
        <h3>Calling code</h3>
        <Code trace={trace} />
      </section>
    </>
  );
}

function ProcessDetail({ proc, snapshot }: { proc: ProcessNode; snapshot: Snapshot }) {
  const descendant = snapshot.agents.find(
    (a) => a.kind === "agent" && a.host === proc.host && a.ancestry.includes(proc.pid),
  );
  const { trace } = useTrace(descendant?.id);
  const agents = snapshot.agents.filter(
    (a) => a.host === proc.host && a.ancestry.includes(proc.pid),
  );
  const now = snapshot.generatedAt;
  const chain = trace?.chain.slice(trace.chain.findIndex((c) => c.pid === proc.pid));
  return (
    <>
      <header className="panel-head">
        <div className="panel-kicker">{proc.kind}</div>
        <h2>
          <AppIcon kind={proc.kind} label={proc.label} proc={proc} size={28} /> {proc.label}
        </h2>
        <code className="cmd block">{proc.command}</code>
      </header>
      <section className="kvs">
        <Row k="PID" v={proc.pid} mono />
        <Row k="Directory" v={homeRelative(proc.cwd)} mono />
        <Row k="Script" v={homeRelative(proc.script)} mono />
        <Row k="Running for" v={proc.startedAt ? duration(now - proc.startedAt) : undefined} />
        <Row k="CPU / RAM" v={`${proc.cpu.toFixed(1)}% · ${proc.rssMb} MB`} />
      </section>
      <section>
        <h3>Agents downstream ({agents.length})</h3>
        <ul className="subs">
          {agents.map((a) => (
            <li key={a.id}>
              <span className={`dot s-${a.state}`} /> {a.name}{" "}
              <span className="muted">
                {STATE_LABEL[a.state].toLowerCase()} {shortDuration(now - a.stateSince)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {proc.kind === "script" && (
        <section>
          <h3>Calling code</h3>
          <Code trace={trace} onlyPid={proc.pid} />
        </section>
      )}
      {chain && chain.length > 1 && (
        <section>
          <h3>Launched from</h3>
          <Chain chain={chain} highlightPid={proc.pid} />
        </section>
      )}
    </>
  );
}

function HostDetail({ name, snapshot }: { name: string; snapshot: Snapshot }) {
  const host = snapshot.hosts?.find((h) => h.name === name);
  const agents = snapshot.agents.filter((a) => (a.host ?? "local") === name);
  const now = snapshot.generatedAt;
  if (!host) return <p className="muted">This machine is no longer watched.</p>;
  return (
    <>
      <header className="panel-head">
        <div className="panel-kicker">
          {host.local ? "This machine" : "Remote machine over SSH"}
        </div>
        <h2>
          <AppIcon kind={host.local ? "host-local" : "host"} label={host.label} size={28} />{" "}
          {host.label}
        </h2>
        <div className={`panel-state h-${host.status}`}>
          <span
            className={`dot ${host.status === "live" ? "s-thinking" : host.status === "error" ? "s-blocked" : "s-waiting"}`}
          />
          {host.status === "live"
            ? "Connected"
            : host.status === "connecting"
              ? "Connecting"
              : "Not connected"}
        </div>
      </header>
      {host.message && (
        <section>
          <h3>Last message</h3>
          <code className="cmd block">{host.message}</code>
          {!host.local && host.status === "error" && (
            <p className="muted small">
              Check that <code>ssh {host.name}</code> works without a password prompt (keys or an
              agent), and that Node 22+ is on the remote PATH for a non-interactive shell. Use{" "}
              <code>--remote-cmd</code> to point at a different install.
            </p>
          )}
        </section>
      )}
      <section className="kvs">
        <Row
          k="Last data"
          v={host.lastSnapshotAt ? `${duration(now - host.lastSnapshotAt)} ago` : "never"}
        />
        <Row k="Agents" v={agents.filter((a) => a.kind === "agent").length} />
      </section>
    </>
  );
}

export function DetailPanel({
  id,
  snapshot,
  onClose,
}: {
  id: string;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const agent = snapshot.agents.find((a) => a.id === id);
  const proc = id.startsWith("proc:") ? snapshot.processes[id.slice(5)] : undefined;
  return (
    <aside className="panel" aria-label="Details">
      <button type="button" className="panel-close" onClick={onClose} aria-label="Close details">
        <Glyph name="x" size={16} />
      </button>
      {agent ? (
        <AgentDetail agent={agent} snapshot={snapshot} />
      ) : proc ? (
        <ProcessDetail proc={proc} snapshot={snapshot} />
      ) : id.startsWith("host:") ? (
        <HostDetail name={id.slice(5)} snapshot={snapshot} />
      ) : id.startsWith("root:background") ? (
        <header className="panel-head">
          <div className="panel-kicker">Background</div>
          <h2>No visible launcher</h2>
          <p className="muted">
            These agents were started by launchd, a daemon, or a process we can't see (for example
            one owned by another user).
          </p>
        </header>
      ) : (
        <p className="muted">This node is gone.</p>
      )}
    </aside>
  );
}

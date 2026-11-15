import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSnippets, traceCode } from "../src/collector/codeTrace.js";
import { DemoSource } from "../src/demo.js";
import { isAllowedHost, startServer } from "../src/server.js";
import type { Snapshot } from "../src/shared/types.js";
import { buildLayout, pipePath, visibleChain } from "../web/src/layout.js";

describe("layout", () => {
  it("lays out the demo fleet as a left-to-right tree with no overlaps", async () => {
    const snap = await new DemoSource(30 * 60_000).snapshot();
    const { nodes, pipes, width, height } = buildLayout(snap);
    const agents = nodes.filter((n) => n.type === "agent");
    expect(agents.length).toBe(snap.agents.filter((a) => a.kind === "agent").length);
    // every agent and subagent is reachable from a source
    for (const n of nodes) if (n.type !== "source") expect(n.parent).toBeDefined();
    // top-level agents share one column
    expect(new Set(agents.filter((a) => !a.parent?.agent).map((a) => a.x)).size).toBe(1);
    // children sit to the right of their parent; boxes never overlap
    for (const p of pipes) expect(p.x1).toBeGreaterThan(p.x0);
    for (const a of nodes)
      for (const b of nodes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("hides finished agents when asked", async () => {
    const snap = await new DemoSource(30 * 60_000).snapshot();
    const { nodes } = buildLayout(snap, { hideFinished: true });
    expect(
      nodes.some((n) => n.agent && (n.agent.state === "done" || n.agent.state === "ended")),
    ).toBe(false);
  });

  it("collapses repeated app processes and skips shells", () => {
    const snap = {
      processes: {
        1: { pid: 1, ppid: 0, kind: "init", label: "launchd" },
        2: { pid: 2, ppid: 1, kind: "ide", label: "VS Code" },
        3: { pid: 3, ppid: 2, kind: "ide", label: "VS Code" },
        4: { pid: 4, ppid: 3, kind: "shell", label: "zsh" },
      },
    } as unknown as Snapshot;
    const chain = visibleChain({ ancestry: [4, 3, 2, 1] } as never, snap.processes);
    expect(chain.map((p) => p.pid)).toEqual([2]);
  });

  it("draws straight and elbowed pipes", () => {
    expect(pipePath(0, 10, 100, 10)).toBe("M0,10 H100");
    expect(pipePath(0, 0, 200, 100)).toMatch(/^M0,0 H\d+ Q.* V.* Q.* H200$/);
  });
});

describe("code trace", () => {
  it("finds claude calls with context and merges overlapping windows", () => {
    const src = [
      "import os",
      "from claude_agent_sdk import query",
      "",
      "x = 1",
      "async for m in query(prompt=p):",
      "  pass",
      "",
      "",
      "",
      "",
      "end",
    ].join("\n");
    const snippets = findSnippets(src);
    expect(snippets).toHaveLength(1);
    const hits = snippets[0]?.lines.filter((l) => l.hit).map((l) => l.n);
    expect(hits).toEqual([2, 5]);
  });

  it("reads scripts from the launch chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const file = join(dir, "run.py");
    await writeFile(file, "import subprocess\nsubprocess.run(['claude', '-p', 'hi'])\n");
    const out = await traceCode([
      {
        pid: 9,
        ppid: 1,
        kind: "script",
        label: "run.py",
        exe: "python3",
        command: "python3 run.py",
        script: file,
        cpu: 0,
        rssMb: 0,
      },
      {
        pid: 8,
        ppid: 1,
        kind: "shell",
        label: "zsh",
        exe: "zsh",
        command: "zsh",
        cpu: 0,
        rssMb: 0,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.snippets[0]?.line).toBe(2);
  });
});

describe("server", () => {
  it("only accepts loopback Host headers", () => {
    expect(isAllowedHost("localhost:4317")).toBe(true);
    expect(isAllowedHost("127.0.0.1:4317")).toBe(true);
    expect(isAllowedHost("[::1]:4317")).toBe(true);
    expect(isAllowedHost("evil.example:4317")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost("box.lan:4317", ["box.lan"])).toBe(true);
  });

  it("serves snapshots and traces, and rejects foreign hosts", async () => {
    const { url, close } = await startServer({
      source: new DemoSource(30 * 60_000),
      host: "127.0.0.1",
      port: 0,
      intervalMs: 1000,
    });
    try {
      const snap = (await (await fetch(`${url}/api/snapshot`)).json()) as Snapshot;
      expect(snap.mode).toBe("demo");
      expect(snap.agents.length).toBeGreaterThan(5);
      const id = snap.agents.find((a) => a.name === "eval shard 1/4")?.id ?? "";
      const trace = (await (
        await fetch(`${url}/api/trace?id=${encodeURIComponent(id)}`)
      ).json()) as {
        code: unknown[];
      };
      expect(trace.code.length).toBe(1);
      expect((await fetch(`${url}/api/trace?id=nope`)).status).toBe(404);
      expect((await fetch(`${url}/api/snapshot`, { method: "POST" })).status).toBe(405);
      // fetch() ignores a custom Host header, so use node:http to simulate DNS rebinding
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          `${url}/api/snapshot`,
          { headers: { host: "attacker.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
    } finally {
      close();
    }
  });
});

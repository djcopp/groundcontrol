import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { DemoSource } from "../src/demo.js";
import { MultiSource, namespaceSnapshot, RemoteHost } from "../src/remote.js";
import { procKey } from "../src/shared/types.js";
import { buildLayout } from "../web/src/layout.js";

const root = join(import.meta.dirname, "..");
const fakeSsh = join(root, "test/fixtures/fake-ssh.sh");
const streamCmd = `"${process.execPath}" --import tsx "${join(root, "src/cli.ts")}" --demo --stream --interval 300`;

const waitFor = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("namespaceSnapshot", () => {
  it("prefixes ids and process keys with the host", async () => {
    const snap = namespaceSnapshot(await new DemoSource(60_000).snapshot(), "devbox");
    for (const a of snap.agents) {
      expect(a.id.startsWith("devbox/")).toBe(true);
      expect(a.host).toBe("devbox");
      if (a.parentAgentId) expect(a.parentAgentId.startsWith("devbox/")).toBe(true);
      for (const pid of a.ancestry) expect(snap.processes[procKey("devbox", pid)]).toBeDefined();
    }
  });
});

describe("stream mode", () => {
  it("emits snapshots, answers traces over stdin, and exits when stdin closes", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--demo", "--stream"], {
      cwd: root,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines: Record<string, unknown>[] = [];
    createInterface({ input: child.stdout }).on("line", (l) => lines.push(JSON.parse(l)));
    await waitFor(() => lines.some((l) => l.type === "snapshot"));
    const snap = lines.find((l) => l.type === "snapshot")?.data as { agents: { id: string }[] };
    const id = snap.agents[0]?.id ?? "";
    child.stdin.write(`${JSON.stringify({ type: "trace", reqId: "7", id })}\n`);
    await waitFor(() => lines.some((l) => l.type === "trace"));
    expect(lines.find((l) => l.type === "trace")).toMatchObject({
      reqId: "7",
      data: { agentId: id },
    });
    const exited = new Promise<number | null>((r) => child.on("exit", r));
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 20_000);
});

describe("RemoteHost + MultiSource", () => {
  it("merges a remote host's agents and routes traces to it", async () => {
    const remote = new RemoteHost({ target: "devbox", ssh: fakeSsh, remoteCommand: streamCmd });
    const multi = new MultiSource(new DemoSource(60_000), [remote]);
    multi.start();
    try {
      await waitFor(() => remote.hostStatus().status === "live");
      const snap = await multi.snapshot();
      expect(snap.hosts?.map((h) => [h.name, h.status])).toEqual([
        ["local", "live"],
        ["devbox", "live"],
      ]);
      const remoteAgent = snap.agents.find((a) => a.host === "devbox");
      expect(remoteAgent).toBeDefined();
      const trace = await multi.trace(remoteAgent?.id ?? "");
      expect(trace?.agentId).toBe(remoteAgent?.id);
      expect(trace?.chain.every((p) => p.host === "devbox")).toBe(true);

      // Each machine roots its own tree in the pipe view.
      const { nodes } = buildLayout(snap);
      const hostRoots = nodes.filter((n) => n.kind === "host");
      expect(hostRoots.map((n) => n.host?.name)).toEqual(["local", "devbox"]);
      const devboxAgent = nodes.find((n) => n.agent?.id === remoteAgent?.id);
      let top = devboxAgent;
      while (top?.parent) top = top.parent;
      expect(top?.id).toBe("host:devbox");
    } finally {
      multi.stop();
    }
  }, 30_000);

  it("reports ssh failures as an error state with the last stderr line", async () => {
    const remote = new RemoteHost({
      target: "nowhere",
      ssh: fakeSsh,
      remoteCommand: "echo 'ssh: Could not resolve hostname nowhere' >&2; exit 255",
      retryMs: 60_000,
    });
    remote.start();
    try {
      await waitFor(() => remote.hostStatus().status === "error");
      expect(remote.hostStatus().message).toContain("Could not resolve hostname");
      expect(remote.snapshot()).toBeUndefined();
    } finally {
      remote.stop();
    }
  });
});

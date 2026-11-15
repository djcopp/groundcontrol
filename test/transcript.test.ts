import { describe, expect, it } from "vitest";
import { deriveState } from "../src/collector/collector.js";
import {
  encodeProjectDir,
  guessEntrypoint,
  parseSessionFile,
  sessionIdFromArgs,
} from "../src/collector/sessions.js";
import { summariseToolInput, TranscriptTracker } from "../src/collector/transcript.js";

const T = (s: number) => new Date(Date.UTC(2026, 10, 21, 0, 0, s)).toISOString();
const ms = (s: number) => Date.parse(T(s));
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

const prompt = (s: number, text = "fix the bug") =>
  line({ type: "user", timestamp: T(s), message: { role: "user", content: text } });
const toolUse = (s: number, id: string, name = "Bash", input: unknown = { command: "pnpm test" }) =>
  line({
    type: "assistant",
    timestamp: T(s),
    message: {
      id: `msg_${id}`,
      model: "claude-opus-5-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    },
  });
const toolResult = (s: number, id: string, isError = false) =>
  line({
    type: "user",
    timestamp: T(s),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }],
    },
  });
const reply = (s: number, stop = "end_turn") =>
  line({
    type: "assistant",
    timestamp: T(s),
    message: {
      id: `msg_r${s}`,
      role: "assistant",
      stop_reason: stop,
      content: [{ type: "text", text: "done" }],
    },
  });

function tracker() {
  return new TranscriptTracker("/dev/null", { details: true, windowMs: 60 * 60_000 });
}

describe("TranscriptTracker", () => {
  it("follows a turn: prompt -> tool -> thinking -> waiting", () => {
    const t = tracker();
    t.ingestText(prompt(0));
    expect(t.state).toBe("thinking");
    t.ingestText(toolUse(2, "a"));
    expect(t.state).toBe("tool");
    expect(t.pending.get("a")?.summary).toBe("pnpm test");
    t.ingestText(toolResult(7, "a"));
    expect(t.state).toBe("thinking");
    t.ingestText(reply(9));
    expect(t.state).toBe("waiting");
    expect(t.toolCount).toBe(1);
    expect(t.recentTools[0]).toMatchObject({ name: "Bash", startedAt: ms(2), endedAt: ms(7) });
    expect(t.model).toBe("claude-opus-5-5");
    expect(t.tokens).toEqual({ input: 10, output: 5, cacheRead: 100 });
    const tl = t.timeline(ms(20));
    expect(tl.map((s) => [s.state, (s.end - s.start) / 1000])).toEqual([
      ["thinking", 2],
      ["tool", 5],
      ["thinking", 2],
      ["waiting", 11],
    ]);
  });

  it("stays on tool while any parallel tool is pending", () => {
    const t = tracker();
    t.ingestText(prompt(0) + toolUse(1, "a") + toolUse(1, "b") + toolResult(2, "a"));
    expect(t.state).toBe("tool");
    t.ingestText(toolResult(3, "b"));
    expect(t.state).toBe("thinking");
  });

  it("handles lines split across reads and ignores junk", () => {
    const t = tracker();
    const text = prompt(0) + toolUse(1, "a");
    t.ingestText(text.slice(0, 30));
    t.ingestText(`${text.slice(30)}not json\n`);
    expect(t.state).toBe("tool");
  });

  it("treats an interrupt as the end of the turn", () => {
    const t = tracker();
    t.ingestText(
      prompt(0) + toolUse(1, "a") + prompt(4, "[Request interrupted by user for tool use]"),
    );
    expect(t.state).toBe("waiting");
    expect(t.pending.size).toBe(0);
  });

  it("marks a subagent done after SubagentHandback", () => {
    const t = tracker();
    t.ingestText(
      prompt(0) + toolUse(5, "h", "SubagentHandback", { message: "report" }) + toolResult(6, "h"),
    );
    expect(t.state).toBe("done");
    expect(t.handedBack).toBe(true);
  });

  it("records Agent tool ids for subagent linking", () => {
    const t = tracker();
    t.ingestText(prompt(0) + toolUse(1, "toolu_x", "Agent", { description: "Explore auth" }));
    expect(t.agentToolIds.has("toolu_x")).toBe(true);
    expect(t.pending.get("toolu_x")?.summary).toBe("Explore auth");
  });

  it("applies a live-state override to the open segment", () => {
    const t = tracker();
    t.ingestText(prompt(0) + toolUse(1, "a"));
    const tl = t.timeline(ms(30), "blocked", ms(10));
    expect(tl.map((s) => s.state)).toEqual(["thinking", "tool", "blocked"]);
  });

  it("hides tool arguments when details are off", () => {
    const t = new TranscriptTracker("/dev/null", { details: false, windowMs: 60_000 });
    t.ingestText(prompt(0) + toolUse(1, "a"));
    expect(t.pending.get("a")?.summary).toBe("");
  });
});

describe("summariseToolInput", () => {
  it("summarises common tools", () => {
    expect(summariseToolInput("Bash", { command: "ls", description: "List files" })).toBe(
      "List files",
    );
    expect(summariseToolInput("Edit", { file_path: "/a/b/c/file.ts" })).toBe("c/file.ts");
    expect(summariseToolInput("WebFetch", { url: "https://docs.example.com/x" })).toBe(
      "docs.example.com",
    );
    expect(summariseToolInput("mcp__x__y", { query: "q" })).toBe("q");
    expect(summariseToolInput("Bash", "nope")).toBe("");
  });
});

describe("deriveState", () => {
  const now = ms(100);
  const pending = (name: string, startedAt: number) =>
    new Map([["a", { id: "a", name, summary: "", startedAt }]]);
  const base = { cpu: 0, now, childStarts: [] as number[] };

  it("idle session with a pending tool is blocked on permission", () => {
    const s = deriveState({
      ...base,
      tracker: { pending: pending("Bash", ms(90)), state: "tool", stateSince: ms(90) },
      session: { status: "idle" },
    });
    expect(s.state).toBe("blocked");
  });

  it("long-pending Edit is blocked even when the session says busy", () => {
    const s = deriveState({
      ...base,
      tracker: { pending: pending("Edit", ms(80)), state: "tool", stateSince: ms(80) },
      session: { status: "busy" },
    });
    expect(s.state).toBe("blocked");
  });

  it("long Bash with a child process running is a tool, not blocked", () => {
    const s = deriveState({
      ...base,
      childStarts: [ms(81)],
      tracker: { pending: pending("Bash", ms(80)), state: "tool", stateSince: ms(80) },
      session: { status: "busy" },
    });
    expect(s.state).toBe("tool");
  });

  it("long Bash with no child process is probably a permission prompt", () => {
    const s = deriveState({
      ...base,
      tracker: { pending: pending("Bash", ms(80)), state: "tool", stateSince: ms(80) },
      session: { status: "busy" },
    });
    expect(s.state).toBe("blocked");
  });

  it("uses session status when nothing is pending", () => {
    expect(
      deriveState({
        ...base,
        tracker: { pending: new Map(), state: "waiting", stateSince: ms(10) },
        session: { status: "busy" },
      }).state,
    ).toBe("thinking");
    expect(
      deriveState({
        ...base,
        tracker: { pending: new Map(), state: "thinking", stateSince: ms(10) },
        session: { status: "idle" },
      }).state,
    ).toBe("waiting");
  });

  it("falls back to the transcript, then CPU", () => {
    expect(
      deriveState({
        ...base,
        tracker: { pending: new Map(), state: "thinking", stateSince: ms(10) },
      }).state,
    ).toBe("thinking");
    expect(deriveState({ ...base, cpu: 40 }).state).toBe("thinking");
    expect(deriveState(base).state).toBe("unknown");
  });
});

describe("sessions", () => {
  it("parses session files and rejects junk", () => {
    expect(
      parseSessionFile('{"pid":1,"sessionId":"s","status":"idle","statusUpdatedAt":5}'),
    ).toMatchObject({ pid: 1, sessionId: "s", status: "idle", statusUpdatedAt: 5 });
    expect(parseSessionFile("{}")).toBeUndefined();
    expect(parseSessionFile("nope")).toBeUndefined();
  });
  it("reads session ids from argv", () => {
    const id = "c9eecddd-0590-4927-8ca9-1b3bfe1a2aa9";
    expect(sessionIdFromArgs(`claude --resume=${id} --x`)).toBe(id);
    expect(sessionIdFromArgs(`claude --session-id ${id}`)).toBe(id);
    expect(sessionIdFromArgs("claude -p hello")).toBeUndefined();
  });
  it("encodes project dirs like Claude Code", () => {
    expect(encodeProjectDir("/Users/me/projects/agent-visualiser")).toBe(
      "-Users-me-projects-agent-visualiser",
    );
    expect(encodeProjectDir("/Users/me/Application Support/x.y")).toBe(
      "-Users-me-Application-Support-x-y",
    );
  });
  it("guesses entrypoints", () => {
    expect(guessEntrypoint("claude -p hi")).toBe("headless (-p)");
    expect(guessEntrypoint("claude --output-format stream-json")).toBe("sdk / stream-json");
    expect(guessEntrypoint("claude")).toBe("cli");
    expect(guessEntrypoint("claude", { pid: 1, entrypoint: "claude-desktop" })).toBe(
      "claude-desktop",
    );
  });
});

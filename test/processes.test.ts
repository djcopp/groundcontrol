import { describe, expect, it } from "vitest";
import { ancestorPids, classify, extractScript, resolveScript } from "../src/collector/ancestry.js";
import {
  isClaudeAgent,
  parseEtime,
  parseLsofCwd,
  parsePsComm,
  parsePsStats,
} from "../src/collector/processes.js";

describe("parseEtime", () => {
  it.each([
    ["00:05", 5],
    ["01:02", 62],
    ["01:00:00", 3600],
    ["2-03:04:05", 2 * 86400 + 3 * 3600 + 4 * 60 + 5],
    ["07-04:41:30", 7 * 86400 + 4 * 3600 + 41 * 60 + 30],
    ["", 0],
  ])("%s -> %d", (input, expected) => {
    expect(parseEtime(input)).toBe(expected);
  });
});

describe("ps parsing", () => {
  it("keeps spaces in the command column", () => {
    const out = parsePsStats(
      "  101     1   0.0  1234   01:00 /Applications/Claude.app/Contents/MacOS/Claude --flag a b\n" +
        "52679 52678  23.5 98765 1-00:00:01 /Users/x/Library/Application Support/claude --model opus\n" +
        "garbage line\n",
    );
    expect(out.get(101)).toMatchObject({ ppid: 1, cpu: 0, rssKb: 1234, elapsedSec: 60 });
    expect(out.get(101)?.command).toBe("/Applications/Claude.app/Contents/MacOS/Claude --flag a b");
    expect(out.get(52679)).toMatchObject({ ppid: 52678, cpu: 23.5, elapsedSec: 86401 });
    expect(out.size).toBe(2);
  });

  it("parses comm with spaces", () => {
    const out = parsePsComm("  7 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n");
    expect(out.get(7)).toBe("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
  });

  it("parses lsof -Fn output", () => {
    const out = parseLsofCwd("p10\nfcwd\nn/Users/me/proj\np11\nfcwd\nn/tmp\n");
    expect(out.get(10)).toBe("/Users/me/proj");
    expect(out.get(11)).toBe("/tmp");
  });
});

describe("isClaudeAgent", () => {
  it.each([
    [{ comm: "claude", command: "claude" }, true],
    [{ comm: "/Users/me/.local/share/claude/versions/2.1.318", command: "claude --resume" }, true],
    [
      {
        comm: "/Users/me/Library/Application Support/Claude/claude-code/2.1.328/x/claude.app/Contents/MacOS/claude",
        command:
          "/Users/me/Library/Application Support/Claude/claude-code/2.1.328/x/claude.app/Contents/MacOS/claude --output-format stream-json",
      },
      true,
    ],
    [
      {
        comm: "node",
        command: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi",
      },
      true,
    ],
    [
      { comm: "node", command: "node /app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" },
      true,
    ],
    [
      {
        comm: "/Applications/Claude.app/Contents/MacOS/Claude",
        command: "/Applications/Claude.app/Contents/MacOS/Claude",
      },
      false,
    ],
    [
      {
        comm: "/Applications/Claude.app/Contents/Helpers/disclaimer",
        command: "disclaimer -- claude",
      },
      false,
    ],
    [{ comm: "node", command: "node server.js --name claude" }, false],
    [{ comm: "grep", command: "grep claude" }, false],
  ])("%j -> %s", (p, expected) => {
    expect(isClaudeAgent(p)).toBe(expected);
  });
});

describe("classify", () => {
  const c = (comm: string, command = comm, pid = 100) => classify({ pid, comm, command });
  it("recognises launchers", () => {
    expect(c("/sbin/launchd", "/sbin/launchd", 1)).toMatchObject({ kind: "init" });
    expect(c("/Applications/Claude.app/Contents/MacOS/Claude")).toMatchObject({
      kind: "desktop-app",
      label: "Claude Desktop",
    });
    expect(c("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")).toMatchObject({
      kind: "terminal",
      label: "Terminal",
    });
    expect(c("/Applications/iTerm.app/Contents/MacOS/iTerm2")).toMatchObject({
      kind: "terminal",
      label: "iTerm2",
    });
    expect(c("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toMatchObject({
      label: "Ghostty",
    });
    expect(
      c(
        "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
      ),
    ).toMatchObject({ kind: "ide", label: "VS Code" });
    expect(c("/Applications/Cursor.app/Contents/MacOS/Cursor")).toMatchObject({
      kind: "ide",
      label: "Cursor",
    });
    expect(c("tmux", "tmux new -s work")).toMatchObject({ kind: "multiplexer", label: "tmux" });
    expect(c("-zsh")).toMatchObject({ kind: "shell", label: "zsh" });
    expect(c("login", "login -pfl me")).toMatchObject({ kind: "wrapper" });
    expect(c("sshd", "sshd: me@ttys001")).toMatchObject({ kind: "remote" });
  });

  it("finds the script an interpreter runs", () => {
    expect(c("/usr/bin/python3", "python3 -u orchestrate.py --shards 4")).toMatchObject({
      kind: "script",
      label: "orchestrate.py",
      script: "orchestrate.py",
    });
    expect(c("python3.12", "python3.12 -m agents.run")).toMatchObject({
      label: "python3.12 -m agents.run",
    });
    expect(c("node", "node --enable-source-maps dist/run.js")).toMatchObject({ label: "run.js" });
    expect(c("uv", "uv run --with x scripts/fanout.py")).toMatchObject({
      script: "scripts/fanout.py",
    });
    expect(c("pnpm", "pnpm run agents")).toMatchObject({ label: "pnpm run agents" });
  });

  it("extractScript handles python -c and missing args", () => {
    expect(extractScript("python3", ["-c", "print(1)"])).toBe("-c (inline)");
    expect(extractScript("python3", [])).toBeUndefined();
    expect(extractScript("deno", ["run", "-A", "main.ts"])).toBe("main.ts");
  });

  it("resolves relative scripts against the process cwd", () => {
    expect(resolveScript("orchestrate.py", "/work")).toBe("/work/orchestrate.py");
    expect(resolveScript("/abs/x.py", "/work")).toBe("/abs/x.py");
    expect(resolveScript("-m pkg", "/work")).toBe("-m pkg");
  });
});

describe("ancestorPids", () => {
  it("walks up and stops at init or a loop", () => {
    const procs = new Map([
      [50, { ppid: 40 }],
      [40, { ppid: 30 }],
      [30, { ppid: 1 }],
      [1, { ppid: 0 }],
    ]);
    expect(ancestorPids(50, procs)).toEqual([40, 30, 1]);
    const loop = new Map([
      [5, { ppid: 6 }],
      [6, { ppid: 5 }],
    ]);
    expect(ancestorPids(5, loop)).toEqual([6]);
  });
});

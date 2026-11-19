#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Collector, DEFAULT_OPTIONS } from "./collector/collector.js";
import { DemoSource } from "./demo.js";
import { MultiSource, RemoteHost, runStream } from "./remote.js";
import { type Source, startServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/server/cli.js -> package root; src/cli.ts (tsx) -> package root
const pkgRoot = join(here, "..", existsSync(join(here, "..", "package.json")) ? "" : "..");

function version(): string {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

// Deliberately not `npx -y ...`: that would download and run whatever is published under the name.
const DEFAULT_REMOTE_CMD = "groundcontrol --stream";

const HELP = `groundcontrol: air traffic control for your Claude Code agents.

Usage: groundcontrol [options]

Options:
  -p, --port <n>        Port to serve on (default 4317, 0 = any free port)
      --host <addr>     Interface to bind (default 127.0.0.1). Anything else exposes your
                        process list and file paths to the network.
      --demo            Show simulated agents instead of real ones
      --claude-dir <d>  Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
      --interval <ms>   How often to sample processes (default 1000)
      --window <min>    Minutes of history in the timeline (default 30)
      --no-details      Hide tool arguments (commands, file names) from the UI
      --json            Print one snapshot as JSON and exit
      --no-open         Don't open a browser

Remote machines (over SSH, no ports opened):
      --remote <target> Also watch agents on an SSH host. Repeatable. Any ssh target works:
                        an alias from ~/.ssh/config, user@host, a jump-host alias...
      --remote-cmd <c>  Command run on the remote (default "${DEFAULT_REMOTE_CMD}")
      --ssh <cmd>       SSH client to use (default "ssh"; e.g. "tsh ssh", "gcloud compute ssh")
      --no-local        Only show remote hosts, not this machine
      --stream          Remote end: print snapshots as JSON lines on stdout (used by --remote)
  -v, --version
  -h, --help
`;

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => undefined)
      .unref();
  } catch {
    // no browser available; the URL is printed anyway
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      demo: { type: "boolean" },
      "claude-dir": { type: "string" },
      interval: { type: "string" },
      window: { type: "string" },
      // --no-details / --no-open via allowNegative
      details: { type: "boolean", default: true },
      json: { type: "boolean" },
      open: { type: "boolean", default: true },
      remote: { type: "string", multiple: true },
      "remote-cmd": { type: "string" },
      ssh: { type: "string" },
      local: { type: "boolean", default: true },
      stream: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowNegative: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const windowMs = Number(values.window ?? 30) * 60_000;
  const intervalMs = Math.max(250, Number(values.interval ?? 1000));
  const claudeDir =
    values["claude-dir"] ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const details = values.details !== false;
  const localSource: Source = values.demo
    ? new DemoSource(windowMs)
    : new Collector({ ...DEFAULT_OPTIONS, claudeDir, windowMs, details });

  if (values.stream) {
    runStream(localSource, intervalMs);
    return;
  }

  const remoteTargets = values.remote ?? [];
  let multi: MultiSource | undefined;
  if (remoteTargets.length > 0) {
    const remoteCommand = values["remote-cmd"] ?? DEFAULT_REMOTE_CMD;
    const remotes = remoteTargets.map(
      (target) => new RemoteHost({ target, remoteCommand, ssh: values.ssh ?? "ssh" }),
    );
    multi = new MultiSource(values.local === false ? undefined : localSource, remotes);
    multi.start();
  } else if (values.local === false) {
    throw new Error("--no-local needs at least one --remote host");
  }
  const source: Source = multi ?? localSource;

  if (values.json) {
    process.stdout.write(`${JSON.stringify(await source.snapshot(), null, 2)}\n`);
    return;
  }

  const host = values.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    process.stderr.write(
      `warning: binding to ${host}. Anyone who can reach it can see your agents, processes and paths.\n`,
    );
  }
  const webRoot = join(pkgRoot, "dist", "web");
  const { url, close } = await startServer({
    source,
    host,
    port: Number(values.port ?? 4317),
    intervalMs,
    webRoot: existsSync(webRoot) ? webRoot : undefined,
  });
  process.stdout.write(
    `groundcontrol ${version()} ${values.demo ? "(demo) " : ""}running at ${url}\n` +
      (existsSync(webRoot)
        ? ""
        : "UI not built: run `pnpm build`, or use `pnpm dev` for the Vite UI.\n"),
  );
  if (values.open !== false && existsSync(webRoot)) openBrowser(url);

  const shutdown = () => {
    multi?.stop();
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`groundcontrol: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

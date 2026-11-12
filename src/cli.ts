#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Collector, DEFAULT_OPTIONS } from "./collector/collector.js";
import { DemoSource } from "./demo.js";
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

const HELP = `agent-visualiser: watch your Claude Code agents flow.

Usage: agent-visualiser [options]

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
  const source: Source = values.demo
    ? new DemoSource(windowMs)
    : new Collector({ ...DEFAULT_OPTIONS, claudeDir, windowMs, details });

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
    `agent-visualiser ${version()} ${values.demo ? "(demo) " : ""}running at ${url}\n` +
      (existsSync(webRoot)
        ? ""
        : "UI not built: run `pnpm build`, or use `pnpm dev` for the Vite UI.\n"),
  );
  if (values.open !== false && existsSync(webRoot)) openBrowser(url);

  const shutdown = () => {
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`agent-visualiser: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

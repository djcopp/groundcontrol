import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Snapshot, TraceResponse } from "./shared/types.js";

export interface Source {
  snapshot(): Promise<Snapshot>;
  trace(agentId: string): Promise<TraceResponse | undefined>;
}

export interface ServerOptions {
  source: Source;
  host: string;
  port: number;
  intervalMs: number;
  /** Directory with the built web UI. When missing, only the API is served. */
  webRoot?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * Process lists and file paths are sensitive. The server only binds to loopback by default and
 * rejects requests whose Host header is not loopback (DNS-rebinding protection).
 */
export function isAllowedHost(hostHeader: string | undefined, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  const host = hostHeader
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return ["localhost", "127.0.0.1", "::1", ...extra.map((e) => e.toLowerCase())].includes(host);
}

/** Polls the source once per interval while anyone is watching and fans snapshots out over SSE. */
class Broadcaster {
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | undefined;
  private latest: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;
  private readonly source: Source;
  private readonly intervalMs: number;

  constructor(source: Source, intervalMs: number) {
    this.source = source;
    this.intervalMs = intervalMs;
  }

  async current(): Promise<Snapshot> {
    if (this.latest && Date.now() - this.latest.generatedAt < this.intervalMs) return this.latest;
    return this.refresh();
  }

  private refresh(): Promise<Snapshot> {
    this.inflight ??= this.source
      .snapshot()
      .then((s) => {
        this.latest = s;
        return s;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  add(res: ServerResponse) {
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stop();
    });
    void this.current().then(
      (s) => this.send(res, s),
      () => undefined,
    );
    this.start();
  }

  private send(res: ServerResponse, s: Snapshot) {
    res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const s = await this.refresh();
        for (const c of this.clients) this.send(c, s);
      } catch (err) {
        for (const c of this.clients)
          c.write(`event: error\ndata: ${JSON.stringify(String(err))}\n\n`);
      }
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  closeAll() {
    this.stop();
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function serveStatic(webRoot: string, urlPath: string, res: ServerResponse) {
  const root = resolve(webRoot);
  let rel = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  let target = file;
  try {
    if (!(await stat(target)).isFile()) throw new Error("not file");
  } catch {
    target = join(root, "index.html"); // SPA fallback
  }
  try {
    await stat(target);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("UI not built. Run `pnpm build`.");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": target.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  createReadStream(target).pipe(res);
}

export function startServer(
  opts: ServerOptions,
): Promise<{ server: Server; url: string; close: () => void }> {
  const hub = new Broadcaster(opts.source, opts.intervalMs);
  const wildcard = opts.host === "0.0.0.0" || opts.host === "::";
  const extraHosts = wildcard ? [] : [opts.host];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!wildcard && !isAllowedHost(req.headers.host, extraHosts)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 2000\n\n");
        hub.add(res);
        return;
      }
      if (url.pathname === "/api/snapshot") return json(res, 200, await hub.current());
      if (url.pathname === "/api/trace") {
        const id = url.searchParams.get("id") ?? "";
        const t = await opts.source.trace(id);
        return t ? json(res, 200, t) : json(res, 404, { error: "unknown agent" });
      }
      if (url.pathname === "/api/health") return json(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      if (opts.webRoot) return await serveStatic(opts.webRoot, url.pathname, res);
      res.writeHead(404).end();
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const shownHost = wildcard
        ? "localhost"
        : opts.host.includes(":")
          ? `[${opts.host}]`
          : opts.host;
      resolvePromise({
        server,
        url: `http://${shownHost}:${port}`,
        close: () => {
          hub.closeAll();
          server.close();
        },
      });
    });
  });
}

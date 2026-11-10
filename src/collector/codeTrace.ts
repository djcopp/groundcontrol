import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSnippet, CodeTrace, ProcessNode } from "../shared/types.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT = 3;
const MAX_SNIPPETS = 6;

/** Lines that look like they launch or talk to a Claude agent. */
const HIT_RE =
  /\bclaude\b|claude[_-]agent[_-]sdk|ClaudeSDKClient|ClaudeAgentOptions|@anthropic-ai|anthropic|query\s*\(\s*\{?\s*prompt/i;

export function findSnippets(source: string, re: RegExp = HIT_RE): CodeSnippet[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i] ?? "")) hits.push(i);
  const snippets: CodeSnippet[] = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (snippets.length >= MAX_SNIPPETS) break;
    const start = Math.max(0, h - CONTEXT);
    const end = Math.min(lines.length - 1, h + CONTEXT);
    const prev = snippets[snippets.length - 1];
    if (prev && start <= lastEnd + 1) {
      // merge overlapping windows
      for (let i = lastEnd + 1; i <= end; i++)
        prev.lines.push({ n: i + 1, text: lines[i] ?? "", hit: re.test(lines[i] ?? "") });
      lastEnd = end;
      continue;
    }
    const block: CodeSnippet = { line: h + 1, lines: [] };
    for (let i = start; i <= end; i++)
      block.lines.push({
        n: i + 1,
        text: (lines[i] ?? "").slice(0, 240),
        hit: re.test(lines[i] ?? ""),
      });
    snippets.push(block);
    lastEnd = end;
  }
  return snippets;
}

/** Map a `-m package.module` argument to a file under cwd. */
async function resolveModule(mod: string, cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) return undefined;
  const rel = mod.replace(/\./g, "/");
  for (const cand of [
    `${rel}.py`,
    `${rel}/__main__.py`,
    `src/${rel}.py`,
    `src/${rel}/__main__.py`,
  ]) {
    try {
      if ((await stat(join(cwd, cand))).isFile()) return join(cwd, cand);
    } catch {
      // try next
    }
  }
  return undefined;
}

/** For each script in an agent's launch chain, find the code that starts the agent. */
export async function traceCode(chain: ProcessNode[]): Promise<CodeTrace[]> {
  const out: CodeTrace[] = [];
  for (const node of chain) {
    if (node.kind !== "script" || !node.script) continue;
    let file: string | undefined = node.script;
    if (file.startsWith("-m ")) file = await resolveModule(file.slice(3).trim(), node.cwd);
    if (!file || file.startsWith("-") || file.includes(" ")) continue;
    try {
      const st = await stat(file);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        out.push({ pid: node.pid, label: node.label, file, snippets: [], error: "file too large" });
        continue;
      }
      const source = await readFile(file, "utf8");
      out.push({ pid: node.pid, label: node.label, file, snippets: findSnippets(source) });
    } catch (err) {
      out.push({
        pid: node.pid,
        label: node.label,
        file,
        snippets: [],
        error: (err as NodeJS.ErrnoException).code ?? "unreadable",
      });
    }
  }
  return out;
}

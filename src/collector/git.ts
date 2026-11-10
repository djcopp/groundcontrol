import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { GitInfo } from "../shared/types.js";

const cache = new Map<string, { at: number; info: GitInfo | undefined }>();
const TTL_MS = 10_000;

/** Find the enclosing git repo and current branch by reading .git directly (no git subprocess). */
export async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const info = await lookup(cwd);
  cache.set(cwd, { at: Date.now(), info });
  return info;
}

async function lookup(cwd: string): Promise<GitInfo | undefined> {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const dotgit = join(dir, ".git");
    try {
      const st = await stat(dotgit);
      let gitDir = dotgit;
      if (st.isFile()) {
        // worktree or submodule: "gitdir: <path>"
        const m = (await readFile(dotgit, "utf8")).match(/^gitdir:\s*(.+)$/m);
        if (!m?.[1]) return { root: dir };
        gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : join(dir, m[1].trim());
      }
      const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (ref?.[1]) return { root: dir, branch: ref[1] };
      return { root: dir, commit: head.slice(0, 8) };
    } catch {
      // not here, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

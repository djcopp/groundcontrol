import type { ProcessNode } from "../../src/shared/types.js";

/**
 * Real, full-colour app logos (fetched once by the taste skill's icons.mjs into web/public/icons, licences in
 * icons-credits.json) for the launchers people recognise, and one line-glyph set (Lucide) for everything
 * generic. Logos are their owners' trademarks, used nominatively to name the app an agent was started from.
 */

interface LogoSpec {
  file: string;
  /** One-colour black mark: inverted on dark grounds. */
  ink?: boolean;
}

const LOGOS: Record<string, LogoSpec> = {
  Terminal: { file: "terminal" },
  iTerm2: { file: "iterm2", ink: true },
  Ghostty: { file: "ghostty" },
  WezTerm: { file: "wezterm" },
  Alacritty: { file: "alacritty" },
  Warp: { file: "warp" },
  "GNOME Terminal": { file: "gnometerminal", ink: true },
  "VS Code": { file: "visual-studio-code" },
  Cursor: { file: "cursor", ink: true },
  Windsurf: { file: "windsurf", ink: true },
  Zed: { file: "zedindustries" },
  JetBrains: { file: "intellij-idea" },
  Vim: { file: "vim" },
  Emacs: { file: "emacs" },
  "Claude Desktop": { file: "claude" },
  tmux: { file: "tmux" },
};

const INTERPRETER_LOGOS: [RegExp, LogoSpec][] = [
  [/(^|\/)(python[\d.]*|uv|uvx)$/, { file: "python" }],
  [/(^|\/)(node|npx|npm|pnpm|yarn|tsx|ts-node)$/, { file: "nodejs" }],
  [/(^|\/)bun$/, { file: "bun" }],
  [/(^|\/)deno$/, { file: "deno" }],
  [/(^|\/)ruby$/, { file: "ruby" }],
];

const GLYPH_BY_KIND: Record<string, string> = {
  terminal: "square-terminal",
  ide: "panels-top-left",
  "desktop-app": "panels-top-left",
  multiplexer: "panels-top-left",
  remote: "globe",
  script: "file-code",
  shell: "terminal",
  wrapper: "settings",
  init: "cpu",
  other: "settings",
  background: "clock",
  host: "server",
  "host-local": "laptop",
  subagent: "workflow",
  agent: "terminal",
};

function logoFor(kind: string, label: string, proc?: ProcessNode): LogoSpec | undefined {
  if (kind === "script" && proc) {
    const exe = proc.exe.split("/").pop() ?? "";
    for (const [re, spec] of INTERPRETER_LOGOS) if (re.test(exe)) return spec;
    if (/\.py$/.test(proc.script ?? "")) return { file: "python" };
    if (/\.(m?[jt]s)$/.test(proc.script ?? "")) return { file: "nodejs" };
    return undefined;
  }
  if (label === "JetBrains" && proc) {
    if (/PyCharm/.test(proc.exe)) return { file: "pycharm" };
    if (/WebStorm/.test(proc.exe)) return { file: "webstorm" };
  }
  return LOGOS[label];
}

/** A Lucide line glyph, drawn in the current text colour. */
export function Glyph({ name, size = 16 }: { name: string; size?: number }) {
  const url = `/icons/ui-${name}.svg`;
  return (
    <span
      className="glyph"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
      }}
    />
  );
}

/** The app's real logo on a light tile, or a glyph when the app has none. */
export function AppIcon({
  kind,
  label,
  proc,
  size = 28,
}: {
  kind: string;
  label: string;
  proc?: ProcessNode;
  size?: number;
}) {
  const logo = logoFor(kind, label, proc);
  if (logo) {
    return (
      <span className="ic-tile" style={{ width: size, height: size }} aria-hidden="true">
        <img
          src={`/icons/${logo.file}.svg`}
          alt=""
          className={logo.ink ? "ink" : undefined}
          style={{ width: size * 0.62, height: size * 0.62 }}
        />
      </span>
    );
  }
  return (
    <span className="ic-tile glyph-tile" style={{ width: size, height: size }} aria-hidden="true">
      <Glyph name={GLYPH_BY_KIND[kind] ?? "settings"} size={Math.round(size * 0.55)} />
    </span>
  );
}

/** Top-down airliner, nose pointing right (+x), centred on 0,0, about 20 units long. */
export const PLANE_PATH =
  "M10,0 C10,-1 8.6,-1.5 7,-1.5 L2.5,-1.5 L-2.5,-8.5 L-5,-8.5 L-2,-1.5 L-6.5,-1.5 L-8.5,-4.5 L-10.2,-4.5 L-9,0 L-10.2,4.5 L-8.5,4.5 L-6.5,1.5 L-2,1.5 L-5,8.5 L-2.5,8.5 L2.5,1.5 L7,1.5 C8.6,1.5 10,1 10,0 Z";

export function PlaneIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="-11 -11 22 22"
      aria-hidden="true"
    >
      <path d={PLANE_PATH} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect
        x="2"
        y="12"
        width="28"
        height="8"
        rx="2"
        fill="var(--tarmac)"
        stroke="var(--tarmac-edge)"
      />
      <path
        d="M5 16h22"
        stroke="var(--c-thinking)"
        strokeWidth="1.4"
        strokeDasharray="2.5 2.5"
        className="logo-lights"
      />
      <g transform="translate(17 9) rotate(-18) scale(0.62)">
        <path d={PLANE_PATH} fill="var(--ink)" />
      </g>
    </svg>
  );
}

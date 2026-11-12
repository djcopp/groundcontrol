import type { TimelineSegment } from "../../src/shared/types.js";
import { duration, STATE_LABEL } from "./format.js";

/** A thin "pipe" showing the last N minutes, segment colours = state. */
export function MiniTimeline({
  segments,
  now,
  windowMs,
  live,
  height = 6,
}: {
  segments: TimelineSegment[];
  now: number;
  windowMs: number;
  live: boolean;
  height?: number;
}) {
  const start = now - windowMs;
  return (
    <div className="mini-tl" style={{ height }} aria-hidden="true">
      {segments.map((s, i) => {
        const left = ((s.start - start) / windowMs) * 100;
        const width = ((s.end - s.start) / windowMs) * 100;
        if (width <= 0) return null;
        const isLast = i === segments.length - 1;
        return (
          <span
            key={`${s.start}-${s.state}`}
            className={`seg s-${s.state}${isLast && live ? " open" : ""}`}
            style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(width, 0.4)}%` }}
            title={`${STATE_LABEL[s.state]} · ${duration(s.end - s.start)}`}
          />
        );
      })}
    </div>
  );
}

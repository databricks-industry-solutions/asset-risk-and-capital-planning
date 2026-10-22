import { gradientCss, type RGB } from "../lib/ramps";

/** Gradient colour bar with tick labels (bottom-right of the map, as in the original). */
export function GradientLegend({ title, ramp, ticks }: { title: string; ramp: RGB[]; ticks: string[] }) {
  return (
    <div className="w-64 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="h-2.5 rounded-full" style={{ background: gradientCss(ramp) }} />
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        {ticks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/** Categorical legend (plan year, open findings). */
export function SwatchLegend({ title, items }: { title: string; items: { label: string; color: string }[] }) {
  return (
    <div className="rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {items.map((it) => (
          <span key={it.label} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: it.color }} />
            {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}

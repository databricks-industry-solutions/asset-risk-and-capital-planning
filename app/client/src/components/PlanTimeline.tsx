// The plan's time axis for a map: pick a plan year (or all years), show the work IN that year or everything done
// THROUGH it, and play the program forward. Used by the Plan map and the Risk map's plan-year view.
import { useEffect } from "react";
import { Button, Slider, ToggleGroup, ToggleGroupItem } from "@databricks/appkit-ui/react";
import { Pause, Play } from "lucide-react";
import type { RGBA } from "./AssetMap";

export type PlanView = { year: number | null; mode: "in" | "through" };

export const PLAN_COLORS = ["#dc2626", "#f97316", "#facc15", "#22c55e", "#0ea5e9"];
const rgb = (h: string, a: number): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

/** Colour of an asset whose plan year is `y` (undefined = not in the plan) under the current view. */
export function planColor(y: number | undefined, v: PlanView, highlight = false): RGBA {
  if (highlight) return [255, 255, 255, 255];
  if (!y) return [120, 130, 145, 28];
  const ramp = rgb(PLAN_COLORS[Math.min(4, Math.floor((y - 1) / 2))], 250);
  if (v.year == null) return ramp;
  if (v.mode === "in") return y === v.year ? [255, 107, 53, 255] : y < v.year ? [34, 197, 94, 90] : [120, 130, 145, 40];
  return y <= v.year ? ramp : [120, 130, 145, 28];
}

export function planLegend(v: PlanView, hasPlan: boolean) {
  if (v.year == null || v.mode === "through")
    return ["1-2", "3-4", "5-6", "7-8", "9-10"].map((l, i) => ({ label: `year ${l}`, color: PLAN_COLORS[i] }))
      .concat([{ label: v.year != null ? `later / not in plan` : hasPlan ? "not in plan" : "no plan yet", color: "#78828f" }]);
  return [{ label: `replaced in year ${v.year}`, color: "#ff6b35" }, { label: "replaced earlier", color: "#22c55e" }, { label: "later / not in plan", color: "#78828f" }];
}

export function PlanTimeline({ years, view, onChange, playing, setPlaying, id }: {
  years: number; view: PlanView; onChange: (v: PlanView) => void; playing: boolean; setPlaying: (p: boolean) => void; id?: string;
}) {
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => onChange({ ...view, year: view.year == null || view.year >= years ? 1 : view.year + 1 }), 1300);
    return () => clearInterval(h);
  }, [playing, view, years]);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background/95 px-3 py-1.5 text-xs shadow" id={id}>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { if (!playing && view.year == null) onChange({ ...view, year: 1 }); setPlaying(!playing); }} aria-label={playing ? "pause" : "play"} id={id ? `${id}-play` : undefined}>
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <div className="w-40">
        <Slider min={0} max={years} step={1} value={[view.year ?? 0]} onValueChange={(x: number[]) => { setPlaying(false); onChange({ ...view, year: x[0] === 0 ? null : x[0] }); }} />
      </div>
      <span className="w-16 font-semibold tabular-nums">{view.year == null ? "all years" : `year ${view.year}`}</span>
      <ToggleGroup type="single" value={view.mode} onValueChange={(m: string) => m && onChange({ ...view, mode: m as PlanView["mode"] })} className="h-7">
        <ToggleGroupItem value="in" className="h-7 px-2 text-xs">in year</ToggleGroupItem>
        <ToggleGroupItem value="through" className="h-7 px-2 text-xs">through year</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

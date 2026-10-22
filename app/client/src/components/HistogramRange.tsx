import { useMemo } from "react";
import { Label, Slider } from "@databricks/appkit-ui/react";

// A range slider under a mini-histogram of the actual data (ported from the original ARMOR app), so the user filters
// against the real distribution: bars inside the window are accented, bars outside dimmed.
interface Props {
  label: string;
  values: ArrayLike<number | null>;
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  format?: (n: number) => string;
  bins?: number;
}

export function HistogramRange({ label, values, min, max, step, value, onChange, format = (n) => n.toFixed(2), bins = 30 }: Props) {
  const counts = useMemo(() => {
    const c = new Array<number>(bins).fill(0);
    const span = max - min || 1;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) continue;
      let b = Math.floor(((v - min) / span) * bins);
      if (b < 0) b = 0;
      if (b >= bins) b = bins - 1;
      c[b] += 1;
    }
    return c;
  }, [values, min, max, bins]);
  // sqrt scale so a long tail is still visible next to the bulk
  const peak = Math.sqrt(Math.max(1, ...counts));
  const span = max - min || 1;
  const lo = Math.floor(((value[0] - min) / span) * bins);
  const hi = Math.ceil(((value[1] - min) / span) * bins);
  return (
    <div className="space-y-1">
      <Label className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="font-normal text-muted-foreground tabular-nums">
          {format(value[0])} – {format(value[1])}
        </span>
      </Label>
      <div className="flex h-8 items-end gap-[1px]">
        {counts.map((c, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm"
            style={{ height: `${Math.max(3, (Math.sqrt(c) / peak) * 100)}%`, backgroundColor: i >= lo && i < hi ? "var(--armor)" : "rgba(120,128,145,0.35)" }}
          />
        ))}
      </div>
      <Slider min={min} max={max} step={step} value={value} onValueChange={(v: number[]) => onChange([v[0], v[1]])} />
    </div>
  );
}

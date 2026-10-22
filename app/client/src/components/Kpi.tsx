import type { ReactNode } from "react";
import { Card, CardContent } from "@databricks/appkit-ui/react";
import { Info } from "./Info";

/** KPI tile (same look as the original ARMOR app). `info` = hover definition; `hint` = a short factual sub-value only. */
export function Kpi({ label, value, hint, accent, info, formula, source, id }: { label: string; value: string; hint?: string; accent?: boolean; info?: ReactNode; formula?: string; source?: { label: string; href: string }; id?: string }) {
  return (
    <Card className="shadow-sm" id={id}>
      <CardContent className="pt-5 pb-5">
        <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}{info && <Info formula={formula} source={source}>{info}</Info>}</div>
        <div className="text-2xl font-bold tabular-nums" style={accent ? { color: "var(--armor)" } : undefined}>
          {value}
        </div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/** The compact KPI strip that floats over the map. */
export function KpiStrip({ items }: { items: { label: string; value: string; accent?: boolean }[] }) {
  return (
    <div className="flex gap-6 rounded-lg border bg-background/95 px-5 py-2 shadow-lg backdrop-blur">
      {items.map((k) => (
        <div key={k.label} className="text-center">
          <div className="whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground">{k.label}</div>
          <div className="text-lg font-bold tabular-nums" style={k.accent ? { color: "var(--armor)" } : undefined}>
            {k.value}
          </div>
        </div>
      ))}
    </div>
  );
}

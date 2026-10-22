import { useMemo, useState } from "react";
import { Button, Input, Label, Popover, PopoverContent, PopoverTrigger, ScrollArea } from "@databricks/appkit-ui/react";
import { ChevronDown } from "lucide-react";

/** Multi-select dropdown with search (the original app's feeder / material pickers). Empty set = all. */
export function MultiSelect({ label, options, value, onChange, allLabel, counts, id }: {
  label: string; options: string[]; value: Set<string>; onChange: (v: Set<string>) => void; allLabel: string; counts?: Record<string, number>; id?: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => options.filter((o) => !q || o.toLowerCase().includes(q.toLowerCase())), [options, q]);
  const toggle = (o: string) => { const s = new Set(value); s.has(o) ? s.delete(o) : s.add(o); onChange(s); };
  return (
    <div className="space-y-1.5" id={id}>
      <Label>{label}{value.size > 0 && ` (${value.size})`}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">{value.size === 0 ? allLabel : value.size <= 2 ? [...value].join(", ") : `${value.size} selected`}</span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <div className="flex items-center gap-2 border-b px-2 py-2">
            {options.length > 8 && <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 text-xs" />}
            <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => onChange(new Set())}>All</Button>
          </div>
          <ScrollArea className="max-h-[260px]">
            <div className="p-1">
              {shown.map((o) => (
                <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted">
                  <input type="checkbox" checked={value.has(o)} onChange={() => toggle(o)} />
                  <span className="flex-1 truncate text-sm">{o}</span>
                  {counts && <span className="text-xs text-muted-foreground tabular-nums">{counts[o]?.toLocaleString()}</span>}
                </label>
              ))}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}

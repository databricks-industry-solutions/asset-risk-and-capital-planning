// Thin client for the FastAPI engine (app/app.py). Every number the UI shows comes from these endpoints;
// the browser never invents a cost, a curve, a budget or a territory.

export async function getJSON<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

export async function postJSON<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = await r.text();
    try {
      msg = JSON.parse(msg).detail ?? msg;
    } catch {
      /* plain text */
    }
    throw new Error(msg);
  }
  return r.json();
}

/** Columnar JSON from the server: numbers as arrays, low-cardinality strings as {dict, codes}. */
export type RawColumns = { n: number; columns: Record<string, any> };

export interface Frame {
  n: number;
  num: (name: string) => (number | null)[];
  str: (name: string, i: number) => string | null;
  codes: (name: string) => { dict: (string | null)[]; codes: number[] } | null;
  has: (name: string) => boolean;
}

export function decode(raw: RawColumns): Frame {
  const c = raw.columns;
  return {
    n: raw.n,
    num: (name) => c[name] ?? [],
    str: (name, i) => {
      const col = c[name];
      if (!col) return null;
      return col.dict ? col.dict[col.codes[i]] : col[i];
    },
    codes: (name) => (c[name] && c[name].dict ? c[name] : null),
    has: (name) => name in c,
  };
}

/** Poll the server until it has loaded the data model and model outputs. */
export async function waitReady(onStage: (s: string) => void): Promise<void> {
  for (;;) {
    const st = await getJSON<{ stage: string; error: string | null }>("/api/status");
    if (st.stage === "ready") return;
    if (st.stage === "error") throw new Error(st.error ?? "load failed");
    onStage(st.stage);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

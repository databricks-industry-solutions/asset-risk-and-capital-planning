// Customer-facing number formatting. Never JavaScript exponent notation.

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function fmtInt(x: unknown): string {
  return fin(x) ? int.format(Math.round(x)) : "–";
}

export function fmtUsd(x: unknown, digits = 1): string {
  if (!fin(x)) return "–";
  const a = Math.abs(x);
  const s = x < 0 ? "−" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${int.format(Math.round(a))}`;
}

export function fmtPct(x: unknown): string {
  if (!fin(x)) return "–";
  if (x === 0) return "0%";
  if (x >= 0.1) return `${(x * 100).toFixed(0)}%`;
  if (x >= 0.01) return `${(x * 100).toFixed(1)}%`;
  return `${(x * 100).toFixed(2)}%`;
}

export function fmt1(x: unknown): string {
  return fin(x) ? x.toFixed(1) : "–";
}

export function fmtBig(x: unknown): string {
  if (!fin(x)) return "–";
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(x / 1e3).toFixed(0)}k`;
  if (a >= 100) return int.format(Math.round(x));
  return x.toFixed(1);
}

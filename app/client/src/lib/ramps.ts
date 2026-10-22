// Colour ramps (same palette as the original ARMOR app): risk green -> amber -> red; exposure light -> dark blue.
export type RGB = [number, number, number];

export const RISK_RAMP: RGB[] = [
  [38, 139, 76],
  [140, 190, 60],
  [255, 195, 0],
  [255, 107, 53],
  [208, 0, 0],
];
export const BLUE_RAMP: RGB[] = [
  [222, 235, 247],
  [158, 202, 225],
  [66, 146, 198],
  [33, 95, 165],
  [8, 48, 107],
];
export const AGE_RAMP: RGB[] = [
  [69, 117, 180],
  [145, 191, 219],
  [224, 243, 248],
  [252, 141, 89],
  [215, 48, 39],
];

export function lerp(ramp: RGB[], t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  const seg = tt * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

export function gradientCss(ramp: RGB[]): string {
  return `linear-gradient(to right, ${ramp.map((c, i) => `rgb(${c.join(",")}) ${(i / (ramp.length - 1)) * 100}%`).join(", ")})`;
}

export const ACCENT = "#ff6b35";
export const PROGRAM_COLORS: Record<string, string> = {
  reactive: "#94a3b8",
  age_based: "#8b5cf6",
  risk_ranked: "#ff6b35",
  optimized_plan: "#16a34a",
  feeder_rebuild: "#0ea5e9",
};

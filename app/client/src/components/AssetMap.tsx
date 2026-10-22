// The map canvas shared by the Risk map and Plan pages: a dark MapLibre basemap with deck.gl layers for point
// assets (poles, transformers, devices) and line assets (conductor spans), coloured by whatever the page asks for.
//
// Selection (as in the original app): pointer = click an asset; box = drag a rectangle; lasso = draw freehand.
// The map reports the selection polygon; the page decides what it means (a candidate set, a focus area).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MapGL, { useControl, type MapRef } from "react-map-gl/maplibre";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Frame } from "../lib/api";

export type RGBA = [number, number, number, number];
export type SelectMode = "pointer" | "box" | "lasso";
export const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
export const LIGHT_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

interface Props {
  points: Frame | null;
  lines: Frame | null;
  pointIdx: number[];               // indexes of visible points
  lineIdx: number[];                // indexes of visible lines
  pointColor: (i: number) => RGBA;
  lineColor: (i: number) => RGBA;
  colorKey: string;                 // changes when colours change (deck.gl update trigger)
  onPick?: (assetId: string) => void;
  tooltip?: (kind: "P" | "L", i: number) => string | null;
  selectMode?: SelectMode;
  onSelect?: (polygon: [number, number][]) => void;
  selection?: [number, number][] | null;
  style?: string;
  pointRadius?: number;
  network?: boolean;                // draw each point's link to its parent position (the circuit), as in the original app
  lineWidth?: number;
  onZoom?: (zoom: number) => void;  // reports zoom so the page can switch between feeder and asset views
  fit?: { bounds: [[number, number], [number, number]]; key: string } | null;  // fly to these bounds when key changes
  children?: ReactNode;             // overlays (panels, legends) positioned by the page
}

export function AssetMap(p: Props) {
  const mapRef = useRef<MapRef | null>(null);
  const [drag, setDrag] = useState<[number, number][]>([]);
  const fitted = useRef(false);
  const [loaded, setLoaded] = useState(false);   // the map can only frame the data once it has loaded

  // frame the territory once the data arrives (never a hardcoded city)
  useEffect(() => {
    if (fitted.current || !loaded || !p.points || !p.points.n || !mapRef.current) return;
    const lat = p.points.num("lat"), lon = p.points.num("lon");
    let a = 90, b = -90, c = 180, d = -180;
    for (let i = 0; i < lat.length; i += 7) {
      const y = lat[i], x = lon[i];
      if (y == null || x == null) continue;
      a = Math.min(a, y); b = Math.max(b, y); c = Math.min(c, x); d = Math.max(d, x);
    }
    if (a < b) {
      mapRef.current.fitBounds([[c, a], [d, b]], { padding: 40, duration: 0 });
      fitted.current = true;
    }
  }, [p.points, loaded]);

  useEffect(() => {
    if (p.fit && mapRef.current) mapRef.current.fitBounds(p.fit.bounds, { padding: 80, duration: 800, maxZoom: 15 });
  }, [p.fit?.key]);

  const layers = useMemo(() => {
    const out: any[] = [];
    if (p.network !== false && p.points && p.pointIdx.length && p.points.has("plat")) {
      // the circuit: a line from each structure to the one upstream, coloured like the structure
      const P = p.points, lat = P.num("lat"), lon = P.num("lon"), plat = P.num("plat"), plon = P.num("plon");
      const idx = p.pointIdx.filter((i) => plat[i] != null && plon[i] != null);
      out.push(new PathLayer<number>({
        id: "network", data: idx, pickable: true, widthUnits: "pixels", getWidth: 2.2 * (p.lineWidth ?? 1), widthMinPixels: 1,
        getPath: (i) => [[plon[i]!, plat[i]!], [lon[i]!, lat[i]!]], getColor: p.pointColor, capRounded: true,
        updateTriggers: { getColor: p.colorKey, getWidth: p.lineWidth },
        onClick: (info) => info.object != null && p.onPick?.(P.str("asset_id", info.object)!),
      }));
    }
    if (p.lines && p.lineIdx.length) {
      const L = p.lines, lat = L.num("lat"), lon = L.num("lon"), lat2 = L.num("lat2"), lon2 = L.num("lon2");
      out.push(new PathLayer<number>({
        id: "lines", data: p.lineIdx, pickable: true, widthUnits: "pixels", getWidth: 2 * (p.lineWidth ?? 1), widthMinPixels: 1.2,
        getPath: (i) => [[lon[i]!, lat[i]!], [lon2[i]!, lat2[i]!]], getColor: p.lineColor,
        updateTriggers: { getColor: p.colorKey, getWidth: p.lineWidth },
        onClick: (info) => info.object != null && p.onPick?.(L.str("asset_id", info.object)!),
      }));
    }
    if (p.points && p.pointIdx.length) {
      const P = p.points, lat = P.num("lat"), lon = P.num("lon");
      out.push(new ScatterplotLayer<number>({
        id: "points", data: p.pointIdx, pickable: true, radiusUnits: "pixels", getRadius: p.pointRadius ?? 2.4, radiusMinPixels: 1,
        getPosition: (i) => [lon[i]!, lat[i]!], getFillColor: p.pointColor, updateTriggers: { getFillColor: p.colorKey, getRadius: p.pointRadius },
        onClick: (info) => info.object != null && p.onPick?.(P.str("asset_id", info.object)!),
      }));
    }
    const poly = drag.length > 1 ? drag : p.selection;
    if (poly && poly.length > 2) {
      out.push(new PolygonLayer({ id: "sel", data: [{ polygon: poly }], getPolygon: (d: any) => d.polygon, stroked: true, filled: true,
        getFillColor: [255, 107, 53, 30], getLineColor: [255, 107, 53, 230], lineWidthUnits: "pixels", getLineWidth: 2 }));
    }
    return out;
  }, [p.points, p.lines, p.pointIdx, p.lineIdx, p.colorKey, drag, p.selection, p.network, p.lineWidth, p.pointRadius]);

  // box / lasso capture surface
  const mode = p.selectMode ?? "pointer";
  const toLngLat = (e: React.MouseEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ll = mapRef.current!.unproject([e.clientX - r.left, e.clientY - r.top]);
    return [ll.lng, ll.lat];
  };
  const start = useRef<[number, number] | null>(null);
  const onDown = (e: React.MouseEvent) => { start.current = toLngLat(e); setDrag([start.current]); };
  const onMove = (e: React.MouseEvent) => {
    if (!start.current) return;
    const q = toLngLat(e);
    if (mode === "box") {
      const [x0, y0] = start.current;
      setDrag([[x0, y0], [q[0], y0], [q[0], q[1]], [x0, q[1]]]);
    } else setDrag((d) => [...d, q]);
  };
  const onUp = () => {
    if (drag.length > 2) p.onSelect?.(drag);
    start.current = null;
    setDrag([]);
  };

  return (
    <div className="absolute inset-0">
      <MapGL ref={mapRef} initialViewState={{ longitude: 0, latitude: 20, zoom: 1 }} mapStyle={p.style ?? DARK_STYLE}
        style={{ position: "absolute", inset: 0 }} attributionControl={{ compact: true }} onZoomEnd={(e) => p.onZoom?.(e.viewState.zoom)} onLoad={() => setLoaded(true)}>
        <DeckOverlay interleaved={false} layers={layers}
          getTooltip={(info: any) => {
            if (info.object == null || !p.tooltip) return null;
            const t = p.tooltip(info.layer?.id === "lines" ? "L" : "P", info.object);  // "network" segments belong to their point
            return t ? { text: t, style: { fontSize: "12px", background: "rgba(15,17,22,.92)", color: "#fff", borderRadius: "6px", padding: "6px 8px" } } : null;
          }} />
      </MapGL>
      {mode !== "pointer" && (
        <div className="absolute inset-0 z-10 cursor-crosshair" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} />
      )}
      {p.children}
    </div>
  );
}

/** Ray-casting point-in-polygon, for turning a box/lasso into a set of assets. */
export function insidePolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

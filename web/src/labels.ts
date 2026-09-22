export interface GlobeLabel {
  lat: number;
  lng: number;
  text: string;
  size: number;
  color: string;
}

// Approximate visual centers, not precise geographic centroids - good enough for label placement.
export const CONTINENT_LABELS: GlobeLabel[] = [
  { lat: 7, lng: 21, text: "Africa", size: 1.4, color: "rgba(255, 255, 255, 0.85)" },
  { lat: 45, lng: 90, text: "Asia", size: 1.4, color: "rgba(255, 255, 255, 0.85)" },
  { lat: 54, lng: 15, text: "Europe", size: 1.1, color: "rgba(255, 255, 255, 0.85)" },
  { lat: 45, lng: -100, text: "North America", size: 1.4, color: "rgba(255, 255, 255, 0.85)" },
  { lat: -15, lng: -60, text: "South America", size: 1.3, color: "rgba(255, 255, 255, 0.85)" },
  { lat: -25, lng: 135, text: "Australia", size: 1.1, color: "rgba(255, 255, 255, 0.85)" },
  { lat: -82, lng: 20, text: "Antarctica", size: 1.1, color: "rgba(255, 255, 255, 0.85)" },
];

export const OCEAN_LABELS: GlobeLabel[] = [
  { lat: 0, lng: -150, text: "Pacific Ocean", size: 1.0, color: "rgba(150, 200, 255, 0.8)" },
  { lat: -10, lng: -25, text: "Atlantic Ocean", size: 0.9, color: "rgba(150, 200, 255, 0.8)" },
  { lat: -10, lng: 75, text: "Indian Ocean", size: 0.9, color: "rgba(150, 200, 255, 0.8)" },
  { lat: -65, lng: 0, text: "Southern Ocean", size: 0.8, color: "rgba(150, 200, 255, 0.75)" },
  { lat: 84, lng: 0, text: "Arctic Ocean", size: 0.7, color: "rgba(150, 200, 255, 0.75)" },
];

type Ring = [number, number][];

function ringCentroidAndArea(ring: Ring): { lat: number; lng: number; area: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;

  if (area === 0) {
    const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return { lng: sum[0] / ring.length, lat: sum[1] / ring.length, area: 0 };
  }

  return { lng: cx / (6 * area), lat: cy / (6 * area), area: Math.abs(area) };
}

/** Centroid of a GeoJSON Polygon/MultiPolygon, using the largest ring for MultiPolygons
 * (e.g. so a country with distant island territories gets labeled on its main landmass). */
export function getFeatureCentroid(geometry: {
  type: string;
  coordinates: unknown;
}): { lat: number; lng: number } | null {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as Ring[];
    if (!rings[0]?.length) return null;
    const { lat, lng } = ringCentroidAndArea(rings[0]);
    return { lat, lng };
  }

  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates as Ring[][];
    let best: { lat: number; lng: number; area: number } | null = null;
    for (const poly of polygons) {
      if (!poly[0]?.length) continue;
      const result = ringCentroidAndArea(poly[0]);
      if (!best || result.area > best.area) best = result;
    }
    return best ? { lat: best.lat, lng: best.lng } : null;
  }

  return null;
}

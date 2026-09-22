import { useEffect, useRef } from "react";
import { Map as MaplibreMap, Marker, NavigationControl, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FlightResult } from "../types";
import { getFlightPosition } from "../flightPosition";
import { greatCircleInterpolate, type LatLon } from "../geo";

// CARTO's free, no-key-required vector basemap. Its own tiles already carry
// zoom-dependent country/state-province boundaries and labels, so there's no
// need to fetch or render our own admin boundary layer (unlike the old globe).
const MAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
const ROUTE_SOURCE_ID = "flight-route";
const ROUTE_SAMPLE_POINTS = 128;

interface RouteFeatureCollection {
  type: "FeatureCollection";
  features: [{ type: "Feature"; properties: Record<string, never>; geometry: { type: "LineString"; coordinates: [number, number][] } }];
}

function emptyRoute(): RouteFeatureCollection {
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }] };
}

/**
 * Great-circle route through an ordered list of waypoints, as a lon/lat line with
 * longitude unwrapped so it doesn't jump across the antimeridian. Real flights don't
 * track the dep-arr great circle exactly (ATC routing, wind, approach vectoring), so
 * the live position is threaded in as a waypoint too, rather than connecting departure
 * straight to arrival and leaving the plane marker stranded off the drawn line.
 */
function buildRouteCoordinates(waypoints: LatLon[]): [number, number][] {
  const coords: [number, number][] = [];
  let prevLon: number | null = null;
  for (let seg = 0; seg < waypoints.length - 1; seg++) {
    const start = waypoints[seg];
    const end = waypoints[seg + 1];
    for (let i = seg === 0 ? 0 : 1; i <= ROUTE_SAMPLE_POINTS; i++) {
      const { lat, lon } = greatCircleInterpolate(start, end, i / ROUTE_SAMPLE_POINTS);
      let adjustedLon = lon;
      if (prevLon !== null) {
        while (adjustedLon - prevLon > 180) adjustedLon -= 360;
        while (adjustedLon - prevLon < -180) adjustedLon += 360;
      }
      coords.push([adjustedLon, lat]);
      prevLon = adjustedLon;
    }
  }
  return coords;
}

function planeIconSvg(color: string): string {
  return `
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2 L14 9 L21 13 L21 15 L14 13 L13 20 L16 22 L16 23 L12 22 L8 23 L8 22 L11 20 L10 13 L3 15 L3 13 L10 9 Z"
        fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.5" />
    </svg>
  `;
}

function buildTooltipElement(text: string): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.textContent = text;
  tooltip.style.cssText = `
    position: absolute;
    left: 50%;
    bottom: 130%;
    transform: translateX(-50%);
    background: rgba(38, 43, 59, 0.9);
    color: #fff;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: sans-serif;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  `;
  return tooltip;
}

function buildAirportMarkerElement(color: string, label: string): HTMLDivElement {
  const content = document.createElement("div");
  content.style.cssText = `
    position: relative;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: ${color};
    border: 2px solid rgba(255, 255, 255, 0.85);
    cursor: default;
  `;
  const tooltip = buildTooltipElement(label);
  content.appendChild(tooltip);
  content.addEventListener("mouseenter", () => (tooltip.style.opacity = "1"));
  content.addEventListener("mouseleave", () => (tooltip.style.opacity = "0"));
  return content;
}

function buildPlaneMarkerElement(flightNumber: string, isLive: boolean, onClick: () => void): HTMLDivElement {
  const content = document.createElement("div");
  content.style.cssText = `
    position: relative;
    width: 30px;
    height: 30px;
    cursor: pointer;
    filter: drop-shadow(0 0 6px ${isLive ? "#4fd1ff" : "rgba(255,255,255,0.5)"});
  `;
  content.innerHTML = planeIconSvg(isLive ? "#4fd1ff" : "#c9cdda");

  const tooltip = buildTooltipElement(flightNumber);
  content.appendChild(tooltip);
  content.addEventListener("mouseenter", () => (tooltip.style.opacity = "1"));
  content.addEventListener("mouseleave", () => (tooltip.style.opacity = "0"));
  content.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return content;
}

interface Props {
  flight: FlightResult | null;
  onMarkerClick: () => void;
}

export default function FlightMap({ flight, onMarkerClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const loadedRef = useRef(false);
  const airportMarkersRef = useRef<Marker[]>([]);
  const planeMarkerRef = useRef<Marker | null>(null);
  const hasFramedFlight = useRef<string | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;
  // Current plane position, kept centered whenever the user zooms (see the
  // "zoomend" handler below) so tracking a flight doesn't require re-finding
  // the plane after every zoom step.
  const planePositionRef = useRef<{ lon: number; lat: number } | null>(null);
  // Suppressed during our own fitBounds framing, so it doesn't immediately
  // override that framing's own zoom animation.
  const suppressAutoCenterRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MaplibreMap({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [10, 20],
      zoom: 1.4,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    mapRef.current = map;

    // Keep the plane centered through zoom in/out: MapLibre's default scroll/pinch
    // zoom anchors to the cursor, which walks the plane off-screen after a few
    // steps, so re-center on it once each zoom gesture settles.
    map.on("zoomend", () => {
      if (suppressAutoCenterRef.current) return;
      const pos = planePositionRef.current;
      if (pos) map.easeTo({ center: [pos.lon, pos.lat], duration: 300 });
    });

    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: emptyRoute() as GeoJSON.FeatureCollection });
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-glow`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4fd1ff", "line-width": 6, "line-opacity": 0.2, "line-blur": 2 },
      });
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-line`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4fd1ff", "line-width": 2, "line-opacity": 0.9, "line-dasharray": [2, 1.5] },
      });
      loadedRef.current = true;
    });

    return () => {
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    airportMarkersRef.current.forEach((marker) => marker.remove());
    airportMarkersRef.current = [];
    planeMarkerRef.current?.remove();
    planeMarkerRef.current = null;

    const routeSource = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (!flight) {
      routeSource?.setData(emptyRoute() as GeoJSON.FeatureCollection);
      hasFramedFlight.current = null;
      planePositionRef.current = null;
      return;
    }

    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;
    const bounds = new LngLatBounds();

    if (dep.lat !== null && dep.lon !== null) {
      const marker = new Marker({ element: buildAirportMarkerElement("#4fd1ff", dep.iata ?? dep.icao ?? dep.name) })
        .setLngLat([dep.lon, dep.lat])
        .addTo(map);
      airportMarkersRef.current.push(marker);
      bounds.extend([dep.lon, dep.lat]);
    }
    if (arr.lat !== null && arr.lon !== null) {
      const marker = new Marker({ element: buildAirportMarkerElement("#ff6b6b", arr.iata ?? arr.icao ?? arr.name) })
        .setLngLat([arr.lon, arr.lat])
        .addTo(map);
      airportMarkersRef.current.push(marker);
      bounds.extend([arr.lon, arr.lat]);
    }

    const position = getFlightPosition(flight);
    planePositionRef.current = position ? { lon: position.lon, lat: position.lat } : null;

    if (dep.lat !== null && dep.lon !== null && arr.lat !== null && arr.lon !== null) {
      const waypoints: LatLon[] = [{ lat: dep.lat, lon: dep.lon }];
      if (position) waypoints.push({ lat: position.lat, lon: position.lon });
      waypoints.push({ lat: arr.lat, lon: arr.lon });
      const coords = buildRouteCoordinates(waypoints);
      routeSource?.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }],
      } as GeoJSON.FeatureCollection);
    } else {
      routeSource?.setData(emptyRoute() as GeoJSON.FeatureCollection);
    }
    if (position) {
      const marker = new Marker({
        element: buildPlaneMarkerElement(flight.number, position.isLive, () => onMarkerClickRef.current()),
        rotation: position.headingDeg,
        rotationAlignment: "map",
      })
        .setLngLat([position.lon, position.lat])
        .addTo(map);
      planeMarkerRef.current = marker;
      bounds.extend([position.lon, position.lat]);
    }

    if (hasFramedFlight.current !== flight.number && !bounds.isEmpty()) {
      hasFramedFlight.current = flight.number;
      suppressAutoCenterRef.current = true;
      map.fitBounds(bounds, { padding: 80, maxZoom: 6, duration: 1200 });
      map.once("moveend", () => {
        suppressAutoCenterRef.current = false;
      });
    }
  }, [flight]);

  return (
    <div className="flight-map">
      {/* MapLibre stamps its own `maplibregl-map` class (position: relative) onto
          this element, which would collide with .flight-map's own absolute
          positioning if they were the same node — so MapLibre gets its own child. */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

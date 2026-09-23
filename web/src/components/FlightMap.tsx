import { useEffect, useRef } from "react";
import { Map as MaplibreMap, Marker, NavigationControl, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FlightResult } from "../types";
import { getFlightPosition } from "../flightPosition";
import { greatCircleInterpolate, type LatLon } from "../geo";
import { planeIconSvg } from "../planeIcon";

// CARTO's free, no-key-required vector basemap. Its own tiles already carry
// zoom-dependent country/state-province boundaries and labels, so there's no
// need to fetch or render our own admin boundary layer (unlike the old globe).
const MAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
const ROUTE_SOURCE_ID = "flight-route";
const ROUTE_SAMPLE_POINTS = 128;

// Below this zoom the plane marker stays at its base size; past it, it grows with
// zoom (capped) so a close-up view doesn't leave it looking tiny against the map.
const PLANE_ICON_BASE_SIZE = 30;
const PLANE_ICON_BASE_ZOOM = 4;
const PLANE_ICON_GROWTH_PER_ZOOM = 4;
const PLANE_ICON_MAX_SIZE = 64;

function planeIconSizeForZoom(zoom: number): number {
  const grown = PLANE_ICON_BASE_SIZE + Math.max(0, zoom - PLANE_ICON_BASE_ZOOM) * PLANE_ICON_GROWTH_PER_ZOOM;
  return Math.min(PLANE_ICON_MAX_SIZE, grown);
}

/** Resizes a live plane marker's wrapper and icon together (the tooltip's own % offset rides along). */
function applyPlaneIconSize(marker: Marker | null, zoom: number) {
  if (!marker) return;
  const wrapper = marker.getElement();
  const icon = wrapper.firstElementChild as HTMLElement | null;
  if (!icon) return;
  const size = `${planeIconSizeForZoom(zoom)}px`;
  wrapper.style.width = size;
  wrapper.style.height = size;
  icon.style.width = size;
  icon.style.height = size;
}

interface RouteFeatureCollection {
  type: "FeatureCollection";
  features: [{ type: "Feature"; properties: Record<string, never>; geometry: { type: "LineString"; coordinates: [number, number][] } }];
}

function emptyRoute(): RouteFeatureCollection {
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }] };
}

/**
 * Great-circle route through an ordered list of waypoints, as a lon/lat line with
 * longitude unwrapped so it doesn't jump across the antimeridian.
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

function buildPlaneMarkerElement(
  flightNumber: string,
  isLive: boolean,
  headingDeg: number,
  size: number,
  onClick: () => void
): HTMLDivElement {
  // MapLibre's own Marker `rotation` option rotates the whole element it's given, which
  // would carry the tooltip around with it (upside down at a southbound heading, sideways
  // elsewhere). Only the icon should turn to show heading, so it gets its own child with
  // the rotation applied directly, sitting next to an always-upright tooltip.
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
    width: ${size}px;
    height: ${size}px;
    cursor: pointer;
  `;

  const icon = document.createElement("div");
  icon.style.cssText = `
    width: ${size}px;
    height: ${size}px;
    transform: rotate(${headingDeg}deg);
    filter: drop-shadow(0 0 6px ${isLive ? "#4fd1ff" : "rgba(255,255,255,0.5)"});
  `;
  icon.innerHTML = planeIconSvg(isLive ? "#4fd1ff" : "#c9cdda");
  wrapper.appendChild(icon);

  const tooltip = buildTooltipElement(flightNumber);
  wrapper.appendChild(tooltip);
  wrapper.addEventListener("mouseenter", () => (tooltip.style.opacity = "1"));
  wrapper.addEventListener("mouseleave", () => (tooltip.style.opacity = "0"));
  wrapper.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return wrapper;
}

interface Props {
  flight: FlightResult | null;
  /** Width of any panel covering the map's right edge, kept clear when framing the route. */
  rightInset: number;
  onMarkerClick: () => void;
}

export default function FlightMap({ flight, rightInset, onMarkerClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const loadedRef = useRef(false);
  const airportMarkersRef = useRef<Marker[]>([]);
  const planeMarkerRef = useRef<Marker | null>(null);
  const hasFramedFlight = useRef<string | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;
  const rightInsetRef = useRef(rightInset);
  rightInsetRef.current = rightInset;
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

    // Continuous, not zoomend-only, so the icon grows smoothly as the gesture happens.
    map.on("zoom", () => applyPlaneIconSize(planeMarkerRef.current, map.getZoom()));

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

    // Only the flown portion (departure through the current position) is drawn, not
    // the rest of the route to arrival — the plane hasn't flown that yet.
    if (dep.lat !== null && dep.lon !== null && position) {
      const coords = buildRouteCoordinates([{ lat: dep.lat, lon: dep.lon }, { lat: position.lat, lon: position.lon }]);
      routeSource?.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }],
      } as GeoJSON.FeatureCollection);
    } else {
      routeSource?.setData(emptyRoute() as GeoJSON.FeatureCollection);
    }
    if (position) {
      const marker = new Marker({
        element: buildPlaneMarkerElement(
          flight.number,
          position.isLive,
          position.headingDeg,
          planeIconSizeForZoom(map.getZoom()),
          () => onMarkerClickRef.current()
        ),
      })
        .setLngLat([position.lon, position.lat])
        .addTo(map);
      planeMarkerRef.current = marker;
      bounds.extend([position.lon, position.lat]);
    }

    if (hasFramedFlight.current !== flight.number && !bounds.isEmpty()) {
      hasFramedFlight.current = flight.number;
      suppressAutoCenterRef.current = true;
      map.fitBounds(bounds, {
        padding: { top: 80, bottom: 80, left: 80, right: 80 + rightInsetRef.current },
        maxZoom: 6,
        duration: 1200,
      });
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

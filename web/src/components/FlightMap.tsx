import { useEffect, useRef } from "react";
import { AttributionControl, type IControl, Map as MaplibreMap, Marker, NavigationControl, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";
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

// Mirror the --accent / --text / --muted tokens in index.css; MapLibre paint and
// marker styles can't read CSS custom properties.
const ACCENT = "#1f6fb2";
const INK = "#1c2230";
const ESTIMATE = "#6b7280";

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

/** Top-right map button that pans back to the plane, keeping the current zoom. */
class CenterOnPlaneControl implements IControl {
  private container: HTMLDivElement | null = null;
  private readonly onClick: () => void;

  constructor(onClick: () => void) {
    this.onClick = onClick;
  }

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "center-on-plane";
    button.title = "Center on plane";
    button.setAttribute("aria-label", "Center on plane");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>`;
    button.addEventListener("click", this.onClick);
    container.appendChild(button);
    this.container = container;
    this.setEnabled(false);
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }

  /** Hidden while there's no plane on the map to center on. */
  setEnabled(enabled: boolean) {
    if (this.container) this.container.hidden = !enabled;
  }
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
    background: ${INK};
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

/** Appends a hover tooltip to `element`, shown only while the pointer is over it. */
function attachTooltip(element: HTMLElement, text: string): void {
  const tooltip = buildTooltipElement(text);
  element.appendChild(tooltip);
  element.addEventListener("mouseenter", () => (tooltip.style.opacity = "1"));
  element.addEventListener("mouseleave", () => (tooltip.style.opacity = "0"));
}

function buildAirportMarkerElement(color: string, label: string): HTMLDivElement {
  const content = document.createElement("div");
  content.style.cssText = `
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: ${color};
    border: 2px solid #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    cursor: default;
  `;
  attachTooltip(content, label);
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
    filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35));
  `;
  icon.innerHTML = planeIconSvg(isLive ? ACCENT : ESTIMATE);
  wrapper.appendChild(icon);

  attachTooltip(wrapper, flightNumber);
  wrapper.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return wrapper;
}

interface Props {
  flight: FlightResult | null;
  /** Changes on a timer so an estimated (non-live) position keeps advancing between fetches. */
  clockMs: number;
  /** Space covered by the search card (top), details panel (right) or phone sheet (bottom), kept clear when framing the route. */
  insets: { top: number; right: number; bottom: number };
  /** Changes on each new search or pick; the route is framed once per key rather than per refresh. */
  framingKey: string;
  onMarkerClick: () => void;
}

export default function FlightMap({ flight, clockMs, insets, framingKey, onMarkerClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const loadedRef = useRef(false);
  const airportMarkersRef = useRef<Marker[]>([]);
  const planeMarkerRef = useRef<Marker | null>(null);
  // Which flight (and live vs. estimated styling) the current plane marker was built
  // for; while that matches, updates move the marker instead of rebuilding it, so a
  // refresh doesn't drop an open hover tooltip.
  const planeMarkerKeyRef = useRef<string | null>(null);
  const hasFramedFlight = useRef<string | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const framingKeyRef = useRef(framingKey);
  framingKeyRef.current = framingKey;
  // Current plane position, for the center-on-plane control.
  const planePositionRef = useRef<{ lon: number; lat: number } | null>(null);
  const centerControlRef = useRef<CenterOnPlaneControl | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MaplibreMap({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [10, 20],
      zoom: 1.4,
      attributionControl: false,
    });
    // Bottom-left, not MapLibre's default right side, which the details panel covers.
    // On phones the sheet covers the bottom instead; App.css lifts this corner above it.
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    // App.css moves this corner clear of the details panel (desktop) or search card (phones).
    const centerControl = new CenterOnPlaneControl(() => {
      const pos = planePositionRef.current;
      if (!pos) return;
      // An offset rather than `padding`, which MapLibre would keep applying to every later camera move.
      const { top, right, bottom } = insetsRef.current;
      map.easeTo({ center: [pos.lon, pos.lat], offset: [-right / 2, (top - bottom) / 2], duration: 600 });
    });
    map.addControl(centerControl, "top-right");
    centerControlRef.current = centerControl;
    mapRef.current = map;

    // Continuous, not zoomend-only, so the icon grows smoothly as the gesture happens.
    map.on("zoom", () => applyPlaneIconSize(planeMarkerRef.current, map.getZoom()));

    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: emptyRoute() as FeatureCollection });
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-casing`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-line`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ACCENT, "line-width": 2.5, "line-dasharray": [2, 1.5] },
      });
      loadedRef.current = true;
    });

    return () => {
      map.remove();
      mapRef.current = null;
      centerControlRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    airportMarkersRef.current.forEach((marker) => marker.remove());
    airportMarkersRef.current = [];
    const removePlaneMarker = () => {
      planeMarkerRef.current?.remove();
      planeMarkerRef.current = null;
      planeMarkerKeyRef.current = null;
    };

    const routeSource = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (!flight) {
      removePlaneMarker();
      routeSource?.setData(emptyRoute() as FeatureCollection);
      hasFramedFlight.current = null;
      planePositionRef.current = null;
      centerControlRef.current?.setEnabled(false);
      return;
    }

    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;
    const bounds = new LngLatBounds();

    if (dep.lat !== null && dep.lon !== null) {
      const marker = new Marker({ element: buildAirportMarkerElement(ACCENT, dep.iata ?? dep.icao ?? dep.name) })
        .setLngLat([dep.lon, dep.lat])
        .addTo(map);
      airportMarkersRef.current.push(marker);
      bounds.extend([dep.lon, dep.lat]);
    }
    if (arr.lat !== null && arr.lon !== null) {
      const marker = new Marker({ element: buildAirportMarkerElement(INK, arr.iata ?? arr.icao ?? arr.name) })
        .setLngLat([arr.lon, arr.lat])
        .addTo(map);
      airportMarkersRef.current.push(marker);
      bounds.extend([arr.lon, arr.lat]);
    }

    const position = getFlightPosition(flight);
    planePositionRef.current = position ? { lon: position.lon, lat: position.lat } : null;
    centerControlRef.current?.setEnabled(position !== null);

    // Only the flown portion (departure through the current position) is drawn, not
    // the rest of the route to arrival — the plane hasn't flown that yet.
    if (dep.lat !== null && dep.lon !== null && position) {
      const coords = buildRouteCoordinates([{ lat: dep.lat, lon: dep.lon }, { lat: position.lat, lon: position.lon }]);
      routeSource?.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }],
      } as FeatureCollection);
    } else {
      routeSource?.setData(emptyRoute() as FeatureCollection);
    }
    const planeMarkerKey = position ? `${flight.number}|${position.isLive}` : null;
    if (planeMarkerKey === null || planeMarkerKey !== planeMarkerKeyRef.current) removePlaneMarker();

    if (position && planeMarkerRef.current) {
      planeMarkerRef.current.setLngLat([position.lon, position.lat]);
      const icon = planeMarkerRef.current.getElement().firstElementChild as HTMLElement | null;
      if (icon) icon.style.transform = `rotate(${position.headingDeg}deg)`;
      bounds.extend([position.lon, position.lat]);
    } else if (position) {
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
      planeMarkerKeyRef.current = planeMarkerKey;
      bounds.extend([position.lon, position.lat]);
    }

    const frameId = `${framingKeyRef.current}|${flight.number}|${flight.departure.scheduledUtc ?? ""}`;
    if (hasFramedFlight.current !== frameId && !bounds.isEmpty()) {
      hasFramedFlight.current = frameId;
      map.fitBounds(bounds, {
        padding: {
          top: Math.max(80, insetsRef.current.top + 32),
          bottom: 80 + insetsRef.current.bottom,
          left: 80,
          right: 80 + insetsRef.current.right,
        },
        maxZoom: 6,
        duration: 1200,
      });
    }
  }, [flight, clockMs]);

  return (
    <div className="flight-map">
      {/* MapLibre stamps its own `maplibregl-map` class (position: relative) onto
          this element, which would collide with .flight-map's own absolute
          positioning if they were the same node — so MapLibre gets its own child. */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

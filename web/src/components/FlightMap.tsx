import { useEffect, useRef } from "react";
import { AttributionControl, type IControl, Map as MaplibreMap, Marker, NavigationControl, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";
import type { FlightResult } from "../types";
import { getFlightPosition } from "../flightPosition";
import { flightPhase } from "../flightStatus";
import { angularDistance, destinationPoint, greatCircleInterpolate, type LatLon } from "../geo";
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

const MOON_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>';
const SUN_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>';

/** Bottom-left button toggling the void's background between the starry dark mode and the
 * plain light mode; its icon shows the mode a click would switch *to*. */
class VoidThemeControl implements IControl {
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private readonly onClick: () => void;

  constructor(onClick: () => void) {
    this.onClick = onClick;
  }

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "void-theme-toggle";
    button.addEventListener("click", this.onClick);
    container.appendChild(button);
    this.container = container;
    this.button = button;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.button = null;
  }

  setMode(mode: "light" | "dark") {
    if (!this.button) return;
    const label = mode === "light" ? "Switch to starry background" : "Switch to light background";
    this.button.title = label;
    this.button.setAttribute("aria-label", label);
    this.button.innerHTML = mode === "light" ? MOON_ICON : SUN_ICON;
  }
}

/** "flown" is departure to the plane; "ahead" is the plane (or, with no plane, departure) to arrival. */
type RoutePart = "flown" | "ahead";

function routeData(flown: [number, number][], ahead: [number, number][]): FeatureCollection {
  const parts: [RoutePart, [number, number][]][] = [
    ["flown", flown],
    ["ahead", ahead],
  ];
  return {
    type: "FeatureCollection",
    features: parts
      .filter(([, coordinates]) => coordinates.length > 1)
      .map(([part, coordinates]) => ({ type: "Feature", properties: { part }, geometry: { type: "LineString", coordinates } })),
  };
}

// Closer than this (about 1 km), a route part has no length worth drawing.
const MIN_PART_ANGLE = 1e-4;

/** A zoom that shows the whole globe across most of the view's shorter side. */
function globeOverviewZoom(container: HTMLElement): number {
  const side = Math.min(container.clientWidth, container.clientHeight) || 600;
  // At zoom z the globe's radius is 512 * 2^z / 2π px; aim for a diameter of ~85% of the side.
  return Math.log2((0.425 * side * 2 * Math.PI) / 512);
}

// Inverse of the radius formula above: how many screen px the globe's radius spans at a zoom.
function globeRadiusPx(zoom: number): number {
  return (512 * Math.pow(2, zoom)) / (2 * Math.PI);
}

// A single drag/zoom step's worth of star drift is capped at this many px. The radius-based
// conversion below only holds while the whole sphere is in view; past that, MapLibre flattens
// into a regular map, where the same lng/lat change no longer implies that many screen px.
const STAR_DRIFT_STEP_MAX = 40;
// Matches the tile size in index.css's starfield background, so the offset can wrap instead
// of growing without bound over a long session of dragging.
const STAR_TILE_PX = 280;

/**
 * The heading as drawn on screen, from projecting a point just ahead of the plane. On a
 * globe, north only points straight up at the center of the view, so the compass heading
 * alone would skew the icon everywhere else.
 */
function screenHeading(map: MaplibreMap, pos: LatLon, headingDeg: number): number {
  const ahead = destinationPoint(pos, headingDeg, 0.002);
  const a = map.project([pos.lon, pos.lat]);
  const b = map.project([ahead.lon, ahead.lat]);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.01) return headingDeg - map.getBearing();
  return (Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI;
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
    font: 500 12px/1.5 var(--font);
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
  // The tooltip names where the position comes from, which is also the only key to the
  // marker's color: blue for a position the aircraft reported, gray for one estimated
  // from the schedule.
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

  attachTooltip(wrapper, `${flightNumber}`);
  wrapper.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return wrapper;
}

type Insets = { top: number; right: number; bottom: number };

// How long after a framing starts that a change in the overlays' size re-aims it.
const REFRAME_WINDOW_MS = 1000;

// The globe projection reprojects vector tiles onto a sphere every frame during a camera
// move, which costs more than the flat map's did; a shorter flight leaves less time for a
// slower device to visibly fall behind it.
const ROUTE_FIT_DURATION_MS = 700;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function fitRoute(map: MaplibreMap, bounds: LngLatBounds, insets: Insets) {
  map.fitBounds(bounds, {
    padding: {
      top: Math.max(80, insets.top + 32),
      bottom: 80 + insets.bottom,
      left: 80,
      right: 80 + insets.right,
    },
    maxZoom: 6,
    duration: prefersReducedMotion() ? 0 : ROUTE_FIT_DURATION_MS,
  });
}

interface Props {
  flight: FlightResult | null;
  /** Changes on a timer so an estimated (non-live) position keeps advancing between fetches. */
  clockMs: number;
  /** Space covered by the search card (top), details panel (right) or phone sheet (bottom), kept clear when framing the route. */
  insets: Insets;
  /** Changes on each new search or pick; the route is framed once per key rather than per refresh. */
  framingKey: string;
  onMarkerClick: () => void;
  /** Which background shows behind the globe; App.tsx owns and persists the choice. */
  voidTheme: "light" | "dark";
  onToggleVoidTheme: () => void;
}

export default function FlightMap({ flight, clockMs, insets, framingKey, onMarkerClick, voidTheme, onToggleVoidTheme }: Props) {
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
  const lastFramingRef = useRef<{ bounds: LngLatBounds; at: number } | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const framingKeyRef = useRef(framingKey);
  framingKeyRef.current = framingKey;
  // Current plane position and compass heading, for the center-on-plane control and for
  // re-aiming the icon as the globe turns.
  const planeRef = useRef<{ lon: number; lat: number; headingDeg: number } | null>(null);
  const centerControlRef = useRef<CenterOnPlaneControl | null>(null);
  const voidThemeControlRef = useRef<VoidThemeControl | null>(null);
  const onToggleVoidThemeRef = useRef(onToggleVoidTheme);
  onToggleVoidThemeRef.current = onToggleVoidTheme;
  // Drives the starfield's CSS background-position (see index.css) so it drifts with the
  // globe's rotation instead of sitting static behind it.
  const starCenterRef = useRef<{ lng: number; lat: number } | null>(null);
  const starOffsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MaplibreMap({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [10, 25],
      zoom: globeOverviewZoom(containerRef.current),
      attributionControl: false,
    });
    // A globe at world scale, so a long-haul route curves the way it's really flown;
    // MapLibre flattens it into the regular map as you zoom in, on the same tiles.
    map.on("style.load", () => map.setProjection({ type: "globe" }));
    // Bottom-left, not MapLibre's default right side, which the details panel covers.
    // On phones the sheet covers the bottom instead; App.css lifts this corner above it.
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    // App.css moves this corner clear of the details panel (desktop) or search card (phones).
    const centerControl = new CenterOnPlaneControl(() => {
      const pos = planeRef.current;
      if (!pos) return;
      // An offset rather than `padding`, which MapLibre would keep applying to every later camera move.
      const { top, right, bottom } = insetsRef.current;
      map.easeTo({ center: [pos.lon, pos.lat], offset: [-right / 2, (top - bottom) / 2], duration: prefersReducedMotion() ? 0 : 600 });
    });
    map.addControl(centerControl, "top-right");
    centerControlRef.current = centerControl;
    const voidThemeControl = new VoidThemeControl(() => onToggleVoidThemeRef.current());
    map.addControl(voidThemeControl, "bottom-left");
    voidThemeControlRef.current = voidThemeControl;
    mapRef.current = map;

    // Continuous, not zoomend-only, so the icon grows smoothly as the gesture happens.
    map.on("zoom", () => applyPlaneIconSize(planeMarkerRef.current, map.getZoom()));
    map.on("move", () => {
      const plane = planeRef.current;
      const icon = planeMarkerRef.current?.getElement().firstElementChild as HTMLElement | null | undefined;
      if (plane && icon) icon.style.transform = `rotate(${screenHeading(map, plane, plane.headingDeg)}deg)`;
    });
    map.on("move", () => {
      const center = map.getCenter();
      const prev = starCenterRef.current;
      starCenterRef.current = { lng: center.lng, lat: center.lat };
      if (!prev) return;

      let dLng = center.lng - prev.lng;
      while (dLng > 180) dLng -= 360;
      while (dLng < -180) dLng += 360;
      const dLat = center.lat - prev.lat;

      const degToPx = globeRadiusPx(map.getZoom()) * (Math.PI / 180);
      const clamp = (v: number) => Math.max(-STAR_DRIFT_STEP_MAX, Math.min(STAR_DRIFT_STEP_MAX, v));
      const offset = starOffsetRef.current;
      offset.x = (offset.x - clamp(dLng * degToPx)) % STAR_TILE_PX;
      offset.y = (offset.y + clamp(dLat * degToPx)) % STAR_TILE_PX;
      document.documentElement.style.setProperty("--star-offset-x", `${offset.x}px`);
      document.documentElement.style.setProperty("--star-offset-y", `${offset.y}px`);
    });

    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: routeData([], []) });
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-casing`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["match", ["get", "part"], "flown", 7, 5], "line-opacity": 0.9 },
      });
      // The rest of the route: dashed and lighter, the usual mark for a path not yet taken.
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-ahead`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: ["==", ["get", "part"], "ahead"],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": ACCENT, "line-width": 2, "line-opacity": 0.75, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: `${ROUTE_SOURCE_ID}-flown`,
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: ["==", ["get", "part"], "flown"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ACCENT, "line-width": 3 },
      });
      loadedRef.current = true;
    });

    return () => {
      map.remove();
      mapRef.current = null;
      centerControlRef.current = null;
      voidThemeControlRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  // Keeps the control's icon in sync with the theme App.tsx owns (also runs once on mount,
  // after the effect above has created the control).
  useEffect(() => {
    voidThemeControlRef.current?.setMode(voidTheme);
  }, [voidTheme]);

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
      routeSource?.setData(routeData([], []));
      hasFramedFlight.current = null;
      planeRef.current = null;
      centerControlRef.current?.setEnabled(false);
      return;
    }

    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;
    const depPoint = dep.lat !== null && dep.lon !== null ? { lat: dep.lat, lon: dep.lon } : null;
    const arrPoint = arr.lat !== null && arr.lon !== null ? { lat: arr.lat, lon: arr.lon } : null;

    if (depPoint) {
      const marker = new Marker({ element: buildAirportMarkerElement(ACCENT, `${dep.iata ?? dep.icao ?? dep.name} · departure`) })
        .setLngLat([depPoint.lon, depPoint.lat])
        .addTo(map);
      airportMarkersRef.current.push(marker);
    }
    if (arrPoint) {
      const marker = new Marker({ element: buildAirportMarkerElement(INK, `${arr.iata ?? arr.icao ?? arr.name} · arrival`) })
        .setLngLat([arrPoint.lon, arrPoint.lat])
        .addTo(map);
      airportMarkersRef.current.push(marker);
    }

    const position = getFlightPosition(flight);
    planeRef.current = position ? { lon: position.lon, lat: position.lat, headingDeg: position.headingDeg } : null;
    centerControlRef.current?.setEnabled(position !== null);

    // The whole route, split at the plane: solid behind it, dashed ahead of it. Built as one
    // line so both parts share the same antimeridian unwrapping.
    let flown: [number, number][] = [];
    let ahead: [number, number][] = [];
    if (depPoint && arrPoint && position) {
      const coords = buildRouteCoordinates([depPoint, position, arrPoint]);
      if (angularDistance(depPoint, position) > MIN_PART_ANGLE) flown = coords.slice(0, ROUTE_SAMPLE_POINTS + 1);
      if (angularDistance(position, arrPoint) > MIN_PART_ANGLE) ahead = coords.slice(ROUTE_SAMPLE_POINTS);
    } else if (depPoint && arrPoint) {
      // Canceled or diverted: no plane on the route, but it still shows where it was going.
      ahead = buildRouteCoordinates([depPoint, arrPoint]);
    }
    routeSource?.setData(routeData(flown, ahead));

    const planeMarkerKey = position ? `${flight.number}|${position.isLive}` : null;
    if (planeMarkerKey === null || planeMarkerKey !== planeMarkerKeyRef.current) removePlaneMarker();

    if (position && planeMarkerRef.current) {
      planeMarkerRef.current.setLngLat([position.lon, position.lat]);
      const icon = planeMarkerRef.current.getElement().firstElementChild as HTMLElement | null;
      if (icon) icon.style.transform = `rotate(${screenHeading(map, position, position.headingDeg)}deg)`;
    } else if (position) {
      const marker = new Marker({
        element: buildPlaneMarkerElement(
          flight.number,
          position.isLive,
          screenHeading(map, position, position.headingDeg),
          planeIconSizeForZoom(map.getZoom()),
          () => onMarkerClickRef.current()
        ),
      })
        .setLngLat([position.lon, position.lat])
        .addTo(map);
      planeMarkerRef.current = marker;
      planeMarkerKeyRef.current = planeMarkerKey;
    }

    // In the air, frame the plane and what's still ahead of it; before takeoff or after
    // landing, the whole route. The sampled line, not just its ends, so a route that
    // bows toward the pole isn't cut off.
    const framed =
      flightPhase(flight) === "airborne" && position
        ? ahead.length > 1
          ? ahead
          : [[position.lon, position.lat] as [number, number]]
        : [...flown, ...ahead];
    const bounds = new LngLatBounds();
    framed.forEach((coord) => bounds.extend(coord));
    if (bounds.isEmpty()) {
      [depPoint, arrPoint, position].forEach((point) => point && bounds.extend([point.lon, point.lat]));
    }

    const frameId = `${framingKeyRef.current}|${flight.number}|${flight.departure.scheduledUtc ?? ""}`;
    if (hasFramedFlight.current !== frameId && !bounds.isEmpty()) {
      hasFramedFlight.current = frameId;
      lastFramingRef.current = { bounds, at: Date.now() };
      fitRoute(map, bounds, insetsRef.current);
    }
  }, [flight, clockMs]);

  // The overlays settle a render after the results arrive (the search card grows to hold
  // the leg picker, the phone sheet measures its peek), so a framing that just started is
  // re-aimed at the settled insets rather than leaving the plane under the search card.
  useEffect(() => {
    const map = mapRef.current;
    const last = lastFramingRef.current;
    if (!map || !last || Date.now() - last.at > REFRAME_WINDOW_MS) return;
    fitRoute(map, last.bounds, { top: insets.top, right: insets.right, bottom: insets.bottom });
  }, [insets.top, insets.right, insets.bottom]);

  return (
    <div className="flight-map">
      {/* MapLibre stamps its own `maplibregl-map` class (position: relative) onto
          this element, which would collide with .flight-map's own absolute
          positioning if they were the same node — so MapLibre gets its own child. */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

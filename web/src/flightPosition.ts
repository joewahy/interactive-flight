import { greatCircleInterpolate, initialBearing, type LatLon } from "./geo";
import type { FlightResult } from "./types";

export interface FlightPosition {
  lat: number;
  lon: number;
  headingDeg: number;
  /** True if this is a real ADS-B reported position rather than an estimate. */
  isLive: boolean;
}

/** Progress fraction (0-1) to assume for a flight when exact times aren't available. */
const STATUS_FALLBACK_FRACTION: Record<string, number> = {
  Unknown: 0,
  Expected: 0,
  CheckIn: 0,
  Boarding: 0,
  GateClosed: 0,
  Departed: 0.05,
  Delayed: 0.5,
  EnRoute: 0.5,
  Approaching: 0.95,
  Arrived: 1,
  Diverted: 0.5,
  Canceled: 0,
  CanceledUncertain: 0,
};

function timeMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export interface FlightProgress {
  /** 0-1 fraction along the route; falls back to a per-status estimate without usable times. */
  fraction: number;
  depTimeMs: number | null;
  arrTimeMs: number | null;
}

/**
 * Shared by the map marker's position and the details panel's progress bar, so both
 * always agree on where the flight is along its route.
 */
export function getFlightProgress(flight: FlightResult): FlightProgress {
  const depTimeMs = timeMs(flight.departure.revisedUtc ?? flight.departure.scheduledUtc);
  const arrTimeMs = timeMs(flight.arrival.revisedUtc ?? flight.arrival.scheduledUtc);

  if (depTimeMs !== null && arrTimeMs !== null && arrTimeMs > depTimeMs) {
    const f = (Date.now() - depTimeMs) / (arrTimeMs - depTimeMs);
    return { fraction: Math.min(1, Math.max(0, f)), depTimeMs, arrTimeMs };
  }

  return { fraction: STATUS_FALLBACK_FRACTION[flight.status] ?? 0.5, depTimeMs, arrTimeMs };
}

export function getFlightPosition(flight: FlightResult): FlightPosition | null {
  if (flight.location) {
    return {
      lat: flight.location.lat,
      lon: flight.location.lon,
      headingDeg: flight.location.trackDeg ?? 0,
      isLive: true,
    };
  }

  const dep = flight.departure.airport;
  const arr = flight.arrival.airport;
  if (dep.lat === null || dep.lon === null || arr.lat === null || arr.lon === null) {
    return null;
  }

  const start: LatLon = { lat: dep.lat, lon: dep.lon };
  const end: LatLon = { lat: arr.lat, lon: arr.lon };
  const f = getFlightProgress(flight).fraction;
  const point = greatCircleInterpolate(start, end, f);

  // Estimate heading using the local tangent of the route rather than the
  // start-to-end bearing, so it's still reasonable on long curved routes.
  const before = greatCircleInterpolate(start, end, Math.max(0, f - 0.01));
  const after = greatCircleInterpolate(start, end, Math.min(1, f + 0.01));
  const headingDeg = initialBearing(before, after);

  return { lat: point.lat, lon: point.lon, headingDeg, isLive: false };
}

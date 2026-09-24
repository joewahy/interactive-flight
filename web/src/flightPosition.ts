import { angularDistance, greatCircleInterpolate, initialBearing, type LatLon } from "./geo";
import { flightPhase, latestEstimateUtc, parseApiTime, type FlightPhase } from "./flightStatus";
import type { FlightResult } from "./types";

export interface FlightPosition {
  lat: number;
  lon: number;
  headingDeg: number;
  /** True if this is a real ADS-B reported position rather than an estimate. */
  isLive: boolean;
}

export interface FlightProgress {
  /** 0-1 fraction along the route; null when the route no longer describes the trip (canceled or diverted). */
  fraction: number | null;
  depTimeMs: number | null;
  arrTimeMs: number | null;
  phase: FlightPhase;
}

// Keeps an airborne flight visibly between the endpoints when the clock says it
// should already have landed (running late) or hasn't left yet (departed early).
const AIRBORNE_MIN_FRACTION = 0.02;
const AIRBORNE_MAX_FRACTION = 0.98;

/**
 * How far along the route a reported position is: its distance from departure over the
 * distance via it to arrival, so a path that strays off the great circle still reads right.
 */
function reportedFraction(flight: FlightResult): number | null {
  const dep = flight.departure.airport;
  const arr = flight.arrival.airport;
  const loc = flight.location;
  if (!loc || dep.lat === null || dep.lon === null || arr.lat === null || arr.lon === null) return null;
  const flown = angularDistance({ lat: dep.lat, lon: dep.lon }, loc);
  const remaining = angularDistance(loc, { lat: arr.lat, lon: arr.lon });
  return flown + remaining > 0 ? flown / (flown + remaining) : null;
}

/**
 * Shared by the map marker's position and the details panel's progress bar, so both
 * always agree on where the flight is along its route. Status wins over the clock:
 * a flight still at the gate stays at 0 however late it is, and a canceled flight
 * gets no progress at all rather than one that runs to arrival on schedule. An airborne
 * flight's reported position wins over the clock, which can't see a late takeoff.
 */
export function getFlightProgress(flight: FlightResult): FlightProgress {
  const depTimeMs = parseApiTime(latestEstimateUtc(flight.departure));
  const arrTimeMs = parseApiTime(latestEstimateUtc(flight.arrival));
  const phase = flightPhase(flight);
  const timeFraction =
    depTimeMs !== null && arrTimeMs !== null && arrTimeMs > depTimeMs
      ? (Date.now() - depTimeMs) / (arrTimeMs - depTimeMs)
      : null;

  let fraction: number | null;
  switch (phase) {
    case "canceled":
    case "diverted":
      fraction = null;
      break;
    case "landed":
      fraction = 1;
      break;
    case "pre-departure":
      fraction = 0;
      break;
    case "airborne":
      fraction = Math.min(AIRBORNE_MAX_FRACTION, Math.max(AIRBORNE_MIN_FRACTION, reportedFraction(flight) ?? timeFraction ?? 0.5));
      break;
    default:
      fraction = timeFraction === null ? 0 : Math.min(1, Math.max(0, timeFraction));
  }
  return { fraction, depTimeMs, arrTimeMs, phase };
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
  if (f === null) return null;
  const point = greatCircleInterpolate(start, end, f);

  // Estimate heading using the local tangent of the route rather than the
  // start-to-end bearing, so it's still reasonable on long curved routes.
  const before = greatCircleInterpolate(start, end, Math.max(0, f - 0.01));
  const after = greatCircleInterpolate(start, end, Math.min(1, f + 0.01));
  const headingDeg = initialBearing(before, after);

  return { lat: point.lat, lon: point.lon, headingDeg, isLive: false };
}

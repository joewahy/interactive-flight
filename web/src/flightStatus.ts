import type { FlightResult, Movement } from "./types";

/** AeroDataBox times look like "2026-09-23 19:23Z"; normalized so every browser parses them. */
export function parseApiTime(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}

/** A clock time in the airport's own zone (not the viewer's), so it matches the zone label shown with it. */
export function formatAirportTime(utc: string | null, timeZone: string | null): string {
  const t = parseApiTime(utc);
  if (t === null) return "—";
  try {
    return new Date(t).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
}

/** "45 min", "5 h 34 min", or "2 h". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(Math.abs(ms) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

const DEPARTED_STATUSES = new Set(["Departed", "EnRoute", "Approaching", "Arrived", "Diverted"]);
const AIRBORNE_STATUSES = new Set(["Departed", "EnRoute", "Approaching"]);
const PRE_DEPARTURE_STATUSES = new Set(["Expected", "CheckIn", "Boarding", "GateClosed", "Delayed"]);

export type FlightPhase = "pre-departure" | "airborne" | "landed" | "canceled" | "diverted" | "unknown";

export function flightPhase(flight: FlightResult): FlightPhase {
  const { status } = flight;
  if (status === "Canceled" || status === "CanceledUncertain") return "canceled";
  if (status === "Diverted") return "diverted";
  if (status === "Arrived") return "landed";
  if (AIRBORNE_STATUSES.has(status)) return "airborne";
  if (PRE_DEPARTURE_STATUSES.has(status)) return "pre-departure";
  return "unknown";
}

/** Minutes between the scheduled and revised time; positive is late. Null without a revised time. */
export function delayMinutes(movement: Movement): number | null {
  const scheduled = parseApiTime(movement.scheduledUtc);
  const revised = parseApiTime(movement.revisedUtc);
  if (scheduled === null || revised === null) return null;
  return Math.round((revised - scheduled) / 60_000);
}

// US DOT counts a flight as on time within 15 minutes of schedule; past that it's flagged.
export const LATE_THRESHOLD_MIN = 15;

export type Tone = "good" | "warn" | "bad" | "active" | "neutral";

/** "on time", "16 min early", "1 h 5 min late". */
export function describeDelay(minutes: number): string {
  if (minutes === 0) return "on time";
  const amount = formatDuration(minutes * 60_000);
  return minutes < 0 ? `${amount} early` : `${amount} late`;
}

export function delayTone(minutes: number): Tone {
  if (minutes >= LATE_THRESHOLD_MIN) return "warn";
  if (minutes <= 0) return "good";
  return "neutral";
}

export interface MovementTime {
  label: "Actual" | "Expected";
  /** Null when the event happened but no time was reported for it. */
  utc: string | null;
}

/**
 * "Actual" only once the status confirms the event happened (and a revised time exists
 * for it); until then the best-known time is labelled "Expected", never "Actual". Null
 * when there's nothing honest to expect: a canceled flight, or a diverted flight's
 * arrival at the airport it's no longer going to.
 */
export function movementTime(flight: FlightResult, which: "departure" | "arrival"): MovementTime | null {
  const phase = flightPhase(flight);
  if (phase === "canceled" || (phase === "diverted" && which === "arrival")) return null;
  const movement = flight[which];
  const happened = which === "departure" ? DEPARTED_STATUSES.has(flight.status) : flight.status === "Arrived";
  if (happened) return { label: "Actual", utc: movement.revisedUtc ?? movement.runwayUtc };
  return { label: "Expected", utc: movement.revisedUtc ?? movement.scheduledUtc };
}

export interface StatusSummary {
  tone: Tone;
  headline: string;
  detail: string | null;
}

const PRE_DEPARTURE_HEADLINES: Record<string, string> = {
  Expected: "Scheduled",
  CheckIn: "Check-in open",
  Boarding: "Boarding",
  GateClosed: "Gate closed",
  Delayed: "Delayed",
};

function joinParts(...parts: (string | null | false | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** The one-glance answer for the top of the panel: what's happening and whether it's on time. */
export function summarizeStatus(flight: FlightResult): StatusSummary {
  const dep = flight.departure;
  const arr = flight.arrival;
  const depCode = dep.airport.iata ?? dep.airport.icao ?? "departure";
  const arrCode = arr.airport.iata ?? arr.airport.icao ?? "arrival";
  const depDelay = delayMinutes(dep);
  const arrDelay = delayMinutes(arr);

  switch (flightPhase(flight)) {
    case "canceled":
      return flight.status === "Canceled"
        ? { tone: "bad", headline: "Canceled", detail: `The airline has canceled this ${depCode} to ${arrCode} flight.` }
        : { tone: "warn", headline: "May be canceled", detail: "Reported as possibly canceled. Check with the airline." };

    case "diverted":
      return { tone: "bad", headline: "Diverted", detail: `Not landing at ${arrCode} as planned.` };

    case "landed": {
      const arrival = movementTime(flight, "arrival");
      return {
        tone: arrDelay !== null && arrDelay >= LATE_THRESHOLD_MIN ? "warn" : "good",
        headline: arrDelay === null ? "Landed" : `Landed ${describeDelay(arrDelay)}`,
        detail: joinParts(
          arrival?.utc && `${formatAirportTime(arrival.utc, arr.airport.timeZone)} at ${arrCode}`,
          arr.terminal && `Terminal ${arr.terminal}`,
          arr.baggageBelt && `Belt ${arr.baggageBelt}`
        ),
      };
    }

    case "airborne": {
      const headline = flight.status === "Approaching" ? `Approaching ${arrCode}` : "In the air";
      const expected = movementTime(flight, "arrival");
      const lands = expected?.utc && `Lands ${formatAirportTime(expected.utc, arr.airport.timeZone)} at ${arrCode}`;
      return {
        tone: arrDelay !== null && arrDelay >= LATE_THRESHOLD_MIN ? "warn" : "active",
        headline,
        detail: lands ? joinParts(lands, arrDelay !== null && describeDelay(arrDelay)) : null,
      };
    }

    case "pre-departure": {
      const expected = movementTime(flight, "departure");
      const late = flight.status === "Delayed" || (depDelay !== null && depDelay >= LATE_THRESHOLD_MIN);
      const headline =
        flight.status === "Expected" && depDelay !== null && depDelay >= LATE_THRESHOLD_MIN
          ? `Delayed ${formatDuration(depDelay * 60_000)}`
          : PRE_DEPARTURE_HEADLINES[flight.status] ?? "Scheduled";
      return {
        tone: late ? "warn" : "neutral",
        headline,
        detail: joinParts(
          expected?.utc && `Departs ${formatAirportTime(expected.utc, dep.airport.timeZone)} from ${depCode}`,
          dep.gate && `Gate ${dep.gate}`,
          flight.status !== "Delayed" && depDelay !== null && depDelay !== 0 && describeDelay(depDelay)
        ),
      };
    }

    default:
      return { tone: "neutral", headline: "Status not reported", detail: "The airline hasn't published a status for this flight yet." };
  }
}

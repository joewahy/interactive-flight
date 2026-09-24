import type { FlightResult, Movement } from "./types";

/**
 * AeroDataBox times look like "2026-09-23 19:23Z"; normalized so every browser parses them.
 * Every field passed here is UTC, but location.reportedAtUtc arrives without the "Z", which
 * Date.parse would otherwise read as the viewer's local time.
 */
export function parseApiTime(value: string | null): number | null {
  if (!value) return null;
  const iso = value.trim().replace(" ", "T");
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
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

/** An instant's calendar date in the airport's zone, as "YYYY-MM-DD" (en-CA's format), for comparing days. */
function localDateKey(ms: number, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, ...(timeZone ? { timeZone } : {}) }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-CA", options).format(ms);
  }
}

/**
 * Calendar days from one airport-local date to another, each read in its own zone: 1 for
 * an arrival the day after departure (the "+1" on a boarding pass). Null if either is unknown.
 */
export function localDayOffset(utc: string | null, timeZone: string | null, fromUtc: string | null, fromTimeZone: string | null): number | null {
  const t = parseApiTime(utc);
  const from = parseApiTime(fromUtc);
  if (t === null || from === null) return null;
  const days = (Date.parse(localDateKey(t, timeZone)) - Date.parse(localDateKey(from, fromTimeZone))) / 86_400_000;
  return Number.isFinite(days) ? Math.round(days) : null;
}

/** Like formatAirportTime, but led by the weekday when it isn't today at that airport: "Thu 8:15 PM". */
export function formatAirportWhen(utc: string | null, timeZone: string | null): string {
  const t = parseApiTime(utc);
  if (t === null) return "—";
  const time = formatAirportTime(utc, timeZone);
  if (localDateKey(t, timeZone) === localDateKey(Date.now(), timeZone)) return time;
  try {
    const weekday = new Date(t).toLocaleDateString(undefined, { weekday: "short", ...(timeZone ? { timeZone } : {}) });
    return `${weekday} ${time}`;
  } catch {
    return time;
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

// Takeoff follows the gate departure (and touchdown precedes the gate arrival) by minutes,
// not hours. A runway time this far past the revised gate time means the revised time was
// never updated from the schedule, as AeroDataBox sometimes does on a badly late flight.
const STALE_REVISED_MS = 60 * 60_000;

/** The revised gate time, or the runway time when it shows the revised time is stale. */
function bestKnownUtc(movement: Movement): string | null {
  const revised = parseApiTime(movement.revisedUtc);
  const runway = parseApiTime(movement.runwayUtc);
  if (revised !== null && runway !== null && runway - revised > STALE_REVISED_MS) return movement.runwayUtc;
  return movement.revisedUtc;
}

/** The best current estimate for a movement, falling back to the schedule. */
export function latestEstimateUtc(movement: Movement): string | null {
  return bestKnownUtc(movement) ?? movement.scheduledUtc;
}

/** Minutes between the scheduled and best-known time; positive is late. Null without a revised time. */
export function delayMinutes(movement: Movement): number | null {
  const scheduled = parseApiTime(movement.scheduledUtc);
  const revised = parseApiTime(bestKnownUtc(movement));
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
  if (happened) return { label: "Actual", utc: bestKnownUtc(movement) ?? movement.runwayUtc };
  return { label: "Expected", utc: latestEstimateUtc(movement) };
}

export interface StatusSummary {
  tone: Tone;
  headline: string;
  detail: string | null;
  /** A concrete next step, when there is a real one — e.g. reaching the airline about a cancellation. */
  action?: { label: string; href: string } | null;
}

/** A search for the airline's own contact info — not a fabricated number, but a real, honest next step. */
function contactAirlineAction(airline: string | null): { label: string; href: string } | null {
  if (!airline) return null;
  return {
    label: `Contact ${airline}`,
    href: `https://www.google.com/search?q=${encodeURIComponent(`${airline} customer service`)}`,
  };
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
  const airline = flight.airline?.name ?? null;

  switch (flightPhase(flight)) {
    case "canceled":
      return flight.status === "Canceled"
        ? {
            tone: "bad",
            headline: "Canceled",
            detail: `${airline ?? "The airline"} canceled this ${depCode} to ${arrCode} flight. Contact ${airline ?? "them"} to rebook.`,
            action: contactAirlineAction(airline),
          }
        : {
            tone: "warn",
            headline: "May be canceled",
            detail: `Reported as possibly canceled. Confirm with ${airline ?? "the airline"} before heading to the airport.`,
            action: contactAirlineAction(airline),
          };

    case "diverted":
      return {
        tone: "bad",
        headline: "Diverted",
        detail: `Not landing at ${arrCode} as planned. Contact ${airline ?? "the airline"} for updated arrival details.`,
        action: contactAirlineAction(airline),
      };

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
      const where = flight.status === "Approaching" ? `Approaching ${arrCode}` : "In the air";
      const expected = movementTime(flight, "arrival");
      const landsAt = expected?.utc ? `${formatAirportWhen(expected.utc, arr.airport.timeZone)} at ${arrCode}` : null;
      // Late is the news, so it's the headline in words rather than only the amber tone;
      // where the plane is moves down to the detail.
      if (arrDelay !== null && arrDelay >= LATE_THRESHOLD_MIN) {
        return {
          tone: "warn",
          headline: `Arriving ${formatDuration(arrDelay * 60_000)} late`,
          detail: joinParts(where, landsAt && `lands ${landsAt}`),
        };
      }
      return {
        tone: "active",
        headline: where,
        detail: landsAt ? joinParts(`Lands ${landsAt}`, arrDelay !== null && describeDelay(arrDelay)) : null,
      };
    }

    case "pre-departure": {
      const expected = movementTime(flight, "departure");
      const lateBy = depDelay !== null && depDelay >= LATE_THRESHOLD_MIN ? depDelay : null;
      const late = flight.status === "Delayed" || lateBy !== null;
      const headline =
        (flight.status === "Expected" || flight.status === "Delayed") && lateBy !== null
          ? `Delayed ${formatDuration(lateBy * 60_000)}`
          : PRE_DEPARTURE_HEADLINES[flight.status] ?? "Scheduled";
      return {
        tone: late ? "warn" : "neutral",
        headline,
        detail: joinParts(
          expected?.utc && `Departs ${formatAirportWhen(expected.utc, dep.airport.timeZone)} from ${depCode}`,
          dep.gate && `Gate ${dep.gate}`,
          !headline.startsWith("Delayed ") && depDelay !== null && depDelay !== 0 && describeDelay(depDelay)
        ),
      };
    }

    default:
      return { tone: "neutral", headline: "Status not reported", detail: "The airline hasn't published a status for this flight yet." };
  }
}

const API_BASE = "https://aerodatabox.p.rapidapi.com";
const API_HOST = "aerodatabox.p.rapidapi.com";

// Minimal shape of the AeroDataBox FlightContract response we actually use.
// See https://doc.aerodatabox.com (openapi-rapidapi-v1.json) for the full schema.
interface RawGeoCoordinates {
  lat: number;
  lon: number;
}

interface RawAirport {
  icao?: string | null;
  iata?: string | null;
  name: string;
  shortName?: string | null;
  municipalityName?: string | null;
  countryCode?: string | null;
  timeZone?: string | null;
  location?: RawGeoCoordinates;
}

interface RawDateTime {
  utc: string;
  local: string;
}

interface RawMovement {
  airport: RawAirport;
  scheduledTime?: RawDateTime;
  revisedTime?: RawDateTime;
  runwayTime?: RawDateTime;
  terminal?: string | null;
  gate?: string | null;
  checkInDesk?: string | null;
  baggageBelt?: string | null;
}

interface RawFlight {
  number: string;
  callSign?: string | null;
  status: string;
  isCargo: boolean;
  greatCircleDistance?: { km: number };
  departure: RawMovement;
  arrival: RawMovement;
  airline?: { name: string; iata?: string | null; icao?: string | null };
  aircraft?: {
    reg?: string | null;
    model?: string | null;
    modeS?: string | null;
    image?: { url?: string; author?: string; title?: string };
  };
  location?: {
    lat: number;
    lon: number;
    altitude?: { feet: number };
    groundSpeed?: { kt: number };
    trueTrack?: { deg: number };
    vsiFpm?: number | null;
    reportedAtUtc: string;
  };
}

export interface Airport {
  icao: string | null;
  iata: string | null;
  name: string;
  municipality: string | null;
  countryCode: string | null;
  timeZone: string | null;
  lat: number | null;
  lon: number | null;
}

export interface Movement {
  airport: Airport;
  scheduledUtc: string | null;
  scheduledLocal: string | null;
  revisedUtc: string | null;
  revisedLocal: string | null;
  runwayUtc: string | null;
  terminal: string | null;
  gate: string | null;
  checkInDesk: string | null;
  baggageBelt: string | null;
}

export interface FlightResult {
  number: string;
  callSign: string | null;
  status: string;
  isCargo: boolean;
  greatCircleDistanceKm: number | null;
  airline: { name: string; iata: string | null; icao: string | null } | null;
  aircraft: {
    reg: string | null;
    model: string | null;
    modeS: string | null;
    imageUrl: string | null;
  } | null;
  departure: Movement;
  arrival: Movement;
  location: {
    lat: number;
    lon: number;
    altitudeFt: number | null;
    groundSpeedKt: number | null;
    trackDeg: number | null;
    verticalSpeedFpm: number | null;
    reportedAtUtc: string;
  } | null;
}

function normalizeAirport(a: RawAirport): Airport {
  return {
    icao: a.icao ?? null,
    iata: a.iata ?? null,
    name: a.name,
    municipality: a.municipalityName ?? null,
    countryCode: a.countryCode ?? null,
    timeZone: a.timeZone ?? null,
    lat: a.location?.lat ?? null,
    lon: a.location?.lon ?? null,
  };
}

function normalizeMovement(m: RawMovement): Movement {
  return {
    airport: normalizeAirport(m.airport),
    scheduledUtc: m.scheduledTime?.utc ?? null,
    scheduledLocal: m.scheduledTime?.local ?? null,
    revisedUtc: m.revisedTime?.utc ?? null,
    revisedLocal: m.revisedTime?.local ?? null,
    runwayUtc: m.runwayTime?.utc ?? null,
    terminal: m.terminal ?? null,
    gate: m.gate ?? null,
    checkInDesk: m.checkInDesk ?? null,
    baggageBelt: m.baggageBelt ?? null,
  };
}

function normalizeFlight(f: RawFlight): FlightResult {
  return {
    number: f.number,
    callSign: f.callSign ?? null,
    status: f.status,
    isCargo: f.isCargo,
    greatCircleDistanceKm: f.greatCircleDistance?.km ?? null,
    airline: f.airline
      ? { name: f.airline.name, iata: f.airline.iata ?? null, icao: f.airline.icao ?? null }
      : null,
    aircraft: f.aircraft
      ? {
          reg: f.aircraft.reg ?? null,
          model: f.aircraft.model ?? null,
          modeS: f.aircraft.modeS ?? null,
          imageUrl: f.aircraft.image?.url ?? null,
        }
      : null,
    departure: normalizeMovement(f.departure),
    arrival: normalizeMovement(f.arrival),
    location: f.location
      ? {
          lat: f.location.lat,
          lon: f.location.lon,
          altitudeFt: f.location.altitude?.feet ?? null,
          groundSpeedKt: f.location.groundSpeed?.kt ?? null,
          trackDeg: f.location.trueTrack?.deg ?? null,
          verticalSpeedFpm: f.location.vsiFpm ?? null,
          reportedAtUtc: f.location.reportedAtUtc,
        }
      : null,
  };
}

export class AeroDataBoxError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AeroDataBoxError";
  }
}

export async function fetchFlightsByNumber(
  apiKey: string,
  flightNumber: string
): Promise<FlightResult[]> {
  const url = new URL(`${API_BASE}/flights/Number/${encodeURIComponent(flightNumber)}`);
  url.searchParams.set("withLocation", "true");
  url.searchParams.set("withAircraftImage", "true");

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": apiKey,
      "X-RapidAPI-Host": API_HOST,
    },
  });

  if (res.status === 204) {
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AeroDataBoxError(res.status, body || res.statusText);
  }

  const raw = (await res.json()) as RawFlight[];
  return raw.map(normalizeFlight);
}

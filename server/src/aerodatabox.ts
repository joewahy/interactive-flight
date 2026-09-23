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

interface RawImage {
  url?: string;
  webUrl?: string;
  author?: string;
  title?: string;
  description?: string;
  license?: string;
  htmlAttributions?: string[];
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
    image?: RawImage;
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

/** Per-airframe facts from AeroDataBox's aircraft lookup (by registration). */
export interface AircraftDetails {
  ageYears: number | null;
  firstFlightDate: string | null;
  deliveryDate: string | null;
  numSeats: number | null;
  numEngines: number | null;
  engineType: string | null;
}

interface RawAircraftDetails {
  ageYears?: number | null;
  firstFlightDate?: string | null;
  deliveryDate?: string | null;
  numSeats?: number | null;
  numEngines?: number | null;
  engineType?: string | null;
}

export interface AircraftImage {
  url: string;
  author: string | null;
  pageUrl: string | null;
  title: string | null;
  /** e.g. { name: "CC BY-ND 2.0", url: "https://creativecommons.org/licenses/by-nd/2.0/" }; null when unknown. */
  license: { name: string; url: string | null } | null;
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
    image: AircraftImage | null;
    details: AircraftDetails | null;
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

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The model's type code, e.g. "A321" from "Airbus A321 (Sharklets)" or "737" from
 * "Boeing 737-800": the first word containing a digit, minus any variant suffix.
 */
function modelTypeCode(model: string): string | null {
  const word = model.split(/\s+/).find((w) => /\d/.test(w));
  if (!word) return null;
  const base = word.split("-")[0];
  return squash(/\d/.test(base) ? base : word) || null;
}

// AeroDataBox's license enum. AllRightsReserved is deliberately absent: those photos aren't shown.
const LICENSE_NAMES: Record<string, string> = {
  AttributionCC: "CC BY",
  AttributionShareAlikeCC: "CC BY-SA",
  AttributionNoDerivativesCC: "CC BY-ND",
  AttributionNoncommercialCC: "CC BY-NC",
  AttributionNoncommercialShareAlikeCC: "CC BY-NC-SA",
  AttributionNoncommercialNoDerivativesCC: "CC BY-NC-ND",
  PublicDomainDedicationCC0: "CC0",
  PublicDomainMark: "Public domain",
  NoKnownCopyrightRestrictions: "No known copyright restrictions",
  UnitedStatesGovernmentWork: "United States government work",
};

/**
 * The license's display name and link. The enum has no version, so that and the URL
 * come from the license link in htmlAttributions (e.g. ".../licenses/by-nd/2.0/").
 */
function imageLicense(image: RawImage): AircraftImage["license"] {
  const name = image.license ? LICENSE_NAMES[image.license] : undefined;
  if (!name) return null;
  const url =
    (image.htmlAttributions ?? [])
      .map((html) => html.match(/href=["'](https?:\/\/creativecommons\.org\/[^"']+)["']/)?.[1])
      .find((u): u is string => !!u) ?? null;
  const version = name.startsWith("CC BY") ? url?.match(/\/(\d+\.\d+)\/?$/)?.[1] : undefined;
  return { name: version ? `${name} ${version}` : name, url };
}

const imageCaption = (image: RawImage) => squash(`${image.title ?? ""} ${image.description ?? ""}`);

/** Whether the photo's title or description names this exact airframe. */
function showsRegistration(image: RawImage | undefined, reg: string): boolean {
  return !!image && imageCaption(image).includes(squash(reg));
}

function toAircraftImage(image: RawImage): AircraftImage | null {
  if (!image.url || image.license === "AllRightsReserved") return null;
  return {
    url: image.url,
    author: image.author ?? null,
    pageUrl: image.webUrl ?? null,
    title: image.title ?? null,
    license: imageLicense(image),
  };
}

/**
 * AeroDataBox picks aircraft photos loosely (an A321 once came back with an A400M
 * airshow photo), so only keep one whose title or description names this aircraft's
 * registration or type code. A type-code match can be another airline's plane, so
 * fetchFlightsByNumber then looks for a photo of the exact registration.
 */
function matchingAircraftImage(aircraft: NonNullable<RawFlight["aircraft"]>): AircraftImage | null {
  const image = aircraft.image;
  if (!image) return null;
  const typeCode = aircraft.model ? modelTypeCode(aircraft.model) : null;
  const matches =
    (aircraft.reg && showsRegistration(image, aircraft.reg)) || (typeCode && imageCaption(image).includes(typeCode));
  return matches ? toAircraftImage(image) : null;
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
          image: matchingAircraftImage(f.aircraft),
          details: null,
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
  const flights = raw.map(normalizeFlight);

  const regs = [...new Set(flights.map((f) => f.aircraft?.reg).filter((r): r is string => !!r))];
  const regsWithoutOwnPhoto = [
    ...new Set(
      raw
        .map((f) => f.aircraft)
        .filter((a) => a?.reg && !showsRegistration(a.image, a.reg))
        .map((a) => a!.reg!)
    ),
  ];
  const [detailsByReg, imageByReg] = await Promise.all([
    Promise.all(regs.map(async (reg) => [reg, await fetchAircraftDetails(apiKey, reg)] as const)).then((e) => new Map(e)),
    Promise.all(regsWithoutOwnPhoto.map(async (reg) => [reg, await fetchRegistrationImage(apiKey, reg)] as const)).then(
      (e) => new Map(e)
    ),
  ]);
  for (const f of flights) {
    if (!f.aircraft?.reg) continue;
    f.aircraft.details = detailsByReg.get(f.aircraft.reg) ?? null;
    f.aircraft.image = imageByReg.get(f.aircraft.reg) ?? f.aircraft.image;
  }
  return flights;
}

// An airframe's age, seats and engines don't change between searches, so each
// registration is looked up at most once a day to spare the RapidAPI quota.
const AIRCRAFT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A per-key TTL cache; `get` returns undefined for an absent or expired entry. */
function ttlCache<T>(ttlMs: number) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  return {
    get(key: string): T | undefined {
      const cached = entries.get(key);
      return cached && cached.expiresAt > Date.now() ? cached.value : undefined;
    },
    set(key: string, value: T): void {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

const aircraftCache = ttlCache<AircraftDetails | null>(AIRCRAFT_CACHE_TTL_MS);

/** Best-effort: any failure resolves to null rather than failing the flight search. */
async function fetchAircraftDetails(apiKey: string, reg: string): Promise<AircraftDetails | null> {
  const cached = aircraftCache.get(reg);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`${API_BASE}/aircrafts/reg/${encodeURIComponent(reg)}`, {
      headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": API_HOST },
    });
    // 204/404 mean AeroDataBox doesn't know this airframe; worth caching. Other
    // errors may be transient, so they're retried on the next search.
    if (res.status === 204 || res.status === 404) {
      aircraftCache.set(reg, null);
      return null;
    }
    if (!res.ok) return null;

    const raw = (await res.json()) as RawAircraftDetails;
    const details: AircraftDetails = {
      ageYears: raw.ageYears ?? null,
      firstFlightDate: raw.firstFlightDate ?? null,
      deliveryDate: raw.deliveryDate ?? null,
      numSeats: raw.numSeats ?? null,
      numEngines: raw.numEngines ?? null,
      engineType: raw.engineType ?? null,
    };
    aircraftCache.set(reg, details);
    return details;
  } catch {
    return null;
  }
}

const imageCache = ttlCache<AircraftImage | null>(AIRCRAFT_CACHE_TTL_MS);

/**
 * Best-effort photo of this exact airframe, used when the flight's own photo is only a
 * same-type match. Cached like the details, and any failure resolves to null.
 */
async function fetchRegistrationImage(apiKey: string, reg: string): Promise<AircraftImage | null> {
  const cached = imageCache.get(reg);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`${API_BASE}/aircrafts/reg/${encodeURIComponent(reg)}/image/beta`, {
      headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": API_HOST },
    });
    if (res.status === 204 || res.status === 404) {
      imageCache.set(reg, null);
      return null;
    }
    if (!res.ok) return null;

    const raw = (await res.json()) as RawImage;
    const image = showsRegistration(raw, reg) ? toAircraftImage(raw) : null;
    imageCache.set(reg, image);
    return image;
  } catch {
    return null;
  }
}

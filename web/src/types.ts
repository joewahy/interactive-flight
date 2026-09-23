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
    image: { url: string; author: string | null; pageUrl: string | null } | null;
    details: {
      ageYears: number | null;
      firstFlightDate: string | null;
      deliveryDate: string | null;
      numSeats: number | null;
      numEngines: number | null;
      engineType: string | null;
    } | null;
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

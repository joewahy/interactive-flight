import { useEffect, useState } from "react";
import type { Airport, FlightResult, Movement } from "../types";
import { describeWeatherCode, fetchWeather, type WeatherSnapshot } from "../weather";
import { getFlightProgress } from "../flightPosition";
import { planeIconSvg } from "../planeIcon";

interface Props {
  flight: FlightResult;
  lastUpdatedMs: number | null;
  onClose: () => void;
}

function formatClockTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The airport's own local timezone label (e.g. "PDT (GMT-7)"), independent of the viewer's. */
function formatTimeZoneLabel(timeZone: string | null, atIso: string | null): string | null {
  if (!timeZone) return null;
  const date = atIso ? new Date(atIso) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  try {
    const abbrev = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    if (abbrev && offset && abbrev !== offset) return `${abbrev} (${offset})`;
    return abbrev ?? offset ?? null;
  } catch {
    return null;
  }
}

function formatDurationHM(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/** "just now", "12 min ago", or "1 h 5 min ago". */
function formatAgo(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  if (totalMinutes === 0) return "just now";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours > 0 ? `${hours} h ` : ""}${minutes} min ago`;
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString()} km`;
}

/** "Actual" once the revised/scheduled time has passed, "Estimated" while it's still ahead. */
function movementStatusLabel(movement: Movement): string {
  const iso = movement.revisedUtc ?? movement.scheduledUtc;
  if (!iso) return "Estimated";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Estimated";
  return t <= Date.now() ? "Actual" : "Estimated";
}

function movementMeta(movement: Movement): string | null {
  const parts = [
    movement.terminal ? `Terminal ${movement.terminal}` : null,
    movement.gate ? `Gate ${movement.gate}` : null,
    movement.baggageBelt ? `Belt ${movement.baggageBelt}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "YYYY-MM-DD" as a calendar date, read in UTC so it can't shift a day in the viewer's zone. */
function formatCalendarDate(ymd: string | null): string | null {
  if (!ymd) return null;
  const date = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function compassPoint(deg: number): string {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

type AircraftDetails = NonNullable<NonNullable<FlightResult["aircraft"]>["details"]>;

/** e.g. "12.5 years old · 102 seats · 2 jet engines", skipping whatever's unknown. */
function aircraftFacts(details: AircraftDetails): string | null {
  const engines =
    details.numEngines !== null
      ? `${details.numEngines} ${details.engineType ? `${details.engineType.toLowerCase()} ` : ""}engine${details.numEngines === 1 ? "" : "s"}`
      : null;
  const parts = [
    details.ageYears !== null ? `${details.ageYears.toFixed(1)} years old` : null,
    details.numSeats !== null ? `${details.numSeats} seats` : null,
    engines,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function RouteEndpoint({ airport, atIso }: { airport: Airport; atIso: string | null }) {
  const tz = formatTimeZoneLabel(airport.timeZone, atIso);
  return (
    <div className="route-endpoint">
      <span className="route-code">{airport.iata ?? airport.icao ?? "—"}</span>
      <span className="route-city">{airport.municipality ?? airport.name}</span>
      {tz && <span className="route-tz">{tz}</span>}
    </div>
  );
}

function RouteTimes({ movement, align }: { movement: Movement; align: "left" | "right" }) {
  const meta = movementMeta(movement);
  return (
    <div className={`route-times-col ${align}`}>
      <div className="route-time-box">
        <span className="route-time-label">Scheduled</span>
        <span className="route-time-value">{formatClockTime(movement.scheduledLocal)}</span>
      </div>
      <div className="route-time-box">
        <span className="route-time-label">{movementStatusLabel(movement)}</span>
        <span className="route-time-value emphasis">
          {formatClockTime(movement.revisedLocal ?? movement.scheduledLocal)}
        </span>
      </div>
      {meta && <p className="route-meta dim">{meta}</p>}
    </div>
  );
}

function RouteProgress({ flight }: { flight: FlightResult }) {
  const { fraction, depTimeMs, arrTimeMs } = getFlightProgress(flight);
  const distanceKm = flight.greatCircleDistanceKm;

  const now = Date.now();
  const leftLabel =
    depTimeMs === null
      ? null
      : now >= depTimeMs
        ? `${formatDurationHM(now - depTimeMs)} ago`
        : `in ${formatDurationHM(depTimeMs - now)}`;
  const rightLabel =
    arrTimeMs === null
      ? null
      : now <= arrTimeMs
        ? `in ${formatDurationHM(arrTimeMs - now)}`
        : `${formatDurationHM(now - arrTimeMs)} ago`;

  return (
    <div className="route-progress">
      <div className="route-progress-track">
        <div className="route-progress-fill" style={{ width: `${fraction * 100}%` }} />
        <div
          className="route-progress-plane"
          style={{ left: `${fraction * 100}%` }}
          dangerouslySetInnerHTML={{ __html: planeIconSvg("#4fd1ff") }}
        />
      </div>
      <div className="route-progress-labels">
        <span>
          {distanceKm !== null && `${formatKm(distanceKm * fraction)}, `}
          {leftLabel}
        </span>
        <span>
          {distanceKm !== null && `${formatKm(distanceKm * (1 - fraction))}, `}
          {rightLabel}
        </span>
      </div>
    </div>
  );
}

// Below this, a reported vertical rate is just noise around level flight.
const LEVEL_FLIGHT_FPM = 100;

function AircraftDetailsLines({ details }: { details: AircraftDetails }) {
  const facts = aircraftFacts(details);
  const firstFlight = formatCalendarDate(details.firstFlightDate);
  const delivered = formatCalendarDate(details.deliveryDate);
  const dates = [firstFlight && `First flew ${firstFlight}`, delivered && `delivered ${delivered}`]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      {facts && <p className="aircraft-facts">{facts}</p>}
      {dates && <p className="dim">{dates.charAt(0).toUpperCase() + dates.slice(1)}</p>}
    </>
  );
}

function LiveStats({ location }: { location: NonNullable<FlightResult["location"]> }) {
  const vs = location.verticalSpeedFpm;
  const vertical =
    vs === null
      ? { label: "Vertical rate", value: "—" }
      : Math.abs(vs) < LEVEL_FLIGHT_FPM
        ? { label: "Vertical rate", value: "Level" }
        : {
            label: vs > 0 ? "Climbing" : "Descending",
            value: `${Math.abs(Math.round(vs)).toLocaleString()} ft/min`,
          };
  const reportedMs = Date.parse(location.reportedAtUtc);

  const tiles = [
    {
      label: "Altitude",
      value: location.altitudeFt !== null ? `${Math.round(location.altitudeFt).toLocaleString()} ft` : "—",
    },
    {
      label: "Ground speed",
      value: location.groundSpeedKt !== null ? `${Math.round(location.groundSpeedKt)} kt` : "—",
      sub: location.groundSpeedKt !== null ? `${Math.round(location.groundSpeedKt * 1.852)} km/h` : null,
    },
    {
      label: "Heading",
      value: location.trackDeg !== null ? `${Math.round(location.trackDeg)}° ${compassPoint(location.trackDeg)}` : "—",
    },
    vertical,
  ];

  return (
    <div className="section">
      <h4>Live</h4>
      <div className="live-stats">
        {tiles.map((tile) => (
          <div key={tile.label} className="route-time-box">
            <span className="route-time-label">{tile.label}</span>
            <span className="route-time-value emphasis">{tile.value}</span>
            {"sub" in tile && tile.sub && <span className="dim live-stat-sub">{tile.sub}</span>}
          </div>
        ))}
      </div>
      {!Number.isNaN(reportedMs) && (
        <p className="dim live-reported">Reported {formatAgo(Date.now() - reportedMs)}</p>
      )}
    </div>
  );
}

function WeatherBlock({ label, weather }: { label: string; weather: WeatherSnapshot | null | undefined }) {
  if (weather === undefined) return <p className="weather-line">{label}: loading…</p>;
  if (weather === null) return <p className="weather-line">{label}: unavailable</p>;
  return (
    <p className="weather-line">
      {label}: {Math.round(weather.temperatureC)}°C, {describeWeatherCode(weather.weatherCode)},{" "}
      {Math.round(weather.windSpeedKmh)} km/h wind
    </p>
  );
}

export default function DetailsPanel({ flight, lastUpdatedMs, onClose }: Props) {
  const [depWeather, setDepWeather] = useState<WeatherSnapshot | null | undefined>(undefined);
  const [arrWeather, setArrWeather] = useState<WeatherSnapshot | null | undefined>(undefined);

  const { lat: depLat, lon: depLon } = flight.departure.airport;
  const { lat: arrLat, lon: arrLon } = flight.arrival.airport;

  // Keyed on coordinates rather than the flight object, so the periodic flight
  // refresh doesn't re-fetch weather for the same two airports every minute.
  useEffect(() => {
    setDepWeather(undefined);
    setArrWeather(undefined);

    if (depLat !== null && depLon !== null) {
      fetchWeather(depLat, depLon).then(setDepWeather);
    } else {
      setDepWeather(null);
    }

    if (arrLat !== null && arrLon !== null) {
      fetchWeather(arrLat, arrLon).then(setArrWeather);
    } else {
      setArrWeather(null);
    }
  }, [depLat, depLon, arrLat, arrLon]);

  return (
    <div className="details-panel">
      <button className="close-btn" onClick={onClose} aria-label="Close details">
        ✕
      </button>

      <div className="details-header">
        <h3>
          {flight.airline?.name ?? flight.number} · {flight.number}
        </h3>
        <div className="details-status-row">
          <p className="status-badge">{flight.status}</p>
          {lastUpdatedMs !== null && (
            <span className="dim details-updated">Updated {formatAgo(Date.now() - lastUpdatedMs)}</span>
          )}
        </div>
      </div>

      {flight.aircraft?.image && (
        <figure className="aircraft-photo">
          <img src={flight.aircraft.image.url} alt={flight.aircraft.model ?? "Aircraft"} loading="lazy" />
          {flight.aircraft.image.author && (
            <figcaption>
              Photo:{" "}
              {flight.aircraft.image.pageUrl ? (
                <a href={flight.aircraft.image.pageUrl} target="_blank" rel="noopener noreferrer">
                  {flight.aircraft.image.author}
                </a>
              ) : (
                flight.aircraft.image.author
              )}
              , CC BY
            </figcaption>
          )}
        </figure>
      )}

      <div className="route-header">
        <RouteEndpoint airport={flight.departure.airport} atIso={flight.departure.revisedLocal ?? flight.departure.scheduledLocal} />
        <div className="route-badge" dangerouslySetInnerHTML={{ __html: planeIconSvg("#0b0d14") }} />
        <RouteEndpoint airport={flight.arrival.airport} atIso={flight.arrival.revisedLocal ?? flight.arrival.scheduledLocal} />
      </div>

      <div className="route-times">
        <RouteTimes movement={flight.departure} align="left" />
        <RouteTimes movement={flight.arrival} align="right" />
      </div>

      <RouteProgress flight={flight} />

      {flight.location && <LiveStats location={flight.location} />}

      <div className="section">
        <h4>Aircraft</h4>
        <p>{flight.aircraft?.model ?? "Unknown model"}</p>
        <p className="dim">{flight.aircraft?.reg ?? "No registration available"}</p>
        {flight.aircraft?.details && <AircraftDetailsLines details={flight.aircraft.details} />}
      </div>

      <div className="section">
        <h4>Weather</h4>
        <WeatherBlock label={flight.departure.airport.iata ?? "Departure"} weather={depWeather} />
        <WeatherBlock label={flight.arrival.airport.iata ?? "Arrival"} weather={arrWeather} />
      </div>

    </div>
  );
}

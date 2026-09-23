import { useEffect, useState } from "react";
import type { Airport, FlightResult, Movement } from "../types";
import { describeWeatherCode, fetchWeather, type WeatherSnapshot } from "../weather";
import { getFlightProgress } from "../flightPosition";
import { planeIconSvg } from "../planeIcon";

interface Props {
  flight: FlightResult;
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

export default function DetailsPanel({ flight, onClose }: Props) {
  const [depWeather, setDepWeather] = useState<WeatherSnapshot | null | undefined>(undefined);
  const [arrWeather, setArrWeather] = useState<WeatherSnapshot | null | undefined>(undefined);

  useEffect(() => {
    setDepWeather(undefined);
    setArrWeather(undefined);

    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;

    if (dep.lat !== null && dep.lon !== null) {
      fetchWeather(dep.lat, dep.lon).then(setDepWeather);
    } else {
      setDepWeather(null);
    }

    if (arr.lat !== null && arr.lon !== null) {
      fetchWeather(arr.lat, arr.lon).then(setArrWeather);
    } else {
      setArrWeather(null);
    }
  }, [flight]);

  return (
    <div className="details-panel">
      <button className="close-btn" onClick={onClose} aria-label="Close details">
        ✕
      </button>

      <div className="details-header">
        <h3>
          {flight.airline?.name ?? flight.number} · {flight.number}
        </h3>
        <p className="status-badge">{flight.status}</p>
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

      <div className="section">
        <h4>Aircraft</h4>
        <p>{flight.aircraft?.model ?? "Unknown model"}</p>
        <p className="dim">{flight.aircraft?.reg ?? "No registration available"}</p>
      </div>

      <div className="section">
        <h4>Weather</h4>
        <WeatherBlock label={flight.departure.airport.iata ?? "Departure"} weather={depWeather} />
        <WeatherBlock label={flight.arrival.airport.iata ?? "Arrival"} weather={arrWeather} />
      </div>

      {flight.location && (
        <div className="section">
          <h4>Live position</h4>
          <p className="dim">
            {flight.location.altitudeFt ? `${Math.round(flight.location.altitudeFt)} ft` : "N/A"}
            {" / "}
            {flight.location.groundSpeedKt ? `${Math.round(flight.location.groundSpeedKt)} kt` : "N/A"}
          </p>
        </div>
      )}
    </div>
  );
}

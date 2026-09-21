import { useEffect, useState } from "react";
import type { FlightResult, Movement } from "../types";
import { describeWeatherCode, fetchWeather, type WeatherSnapshot } from "../weather";

interface Props {
  flight: FlightResult;
  onClose: () => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MovementBlock({ title, movement }: { title: string; movement: Movement }) {
  const { airport } = movement;
  return (
    <div className="movement-block">
      <h4>{title}</h4>
      <p className="airport-name">
        {airport.name}
        {airport.iata ? ` (${airport.iata})` : ""}
      </p>
      <dl>
        <dt>Scheduled</dt>
        <dd>{formatTime(movement.scheduledLocal)}</dd>
        <dt>Revised / actual</dt>
        <dd>{formatTime(movement.revisedLocal)}</dd>
        {movement.terminal && (
          <>
            <dt>Terminal</dt>
            <dd>{movement.terminal}</dd>
          </>
        )}
        {movement.gate && (
          <>
            <dt>Gate</dt>
            <dd>{movement.gate}</dd>
          </>
        )}
        {movement.baggageBelt && (
          <>
            <dt>Baggage belt</dt>
            <dd>{movement.baggageBelt}</dd>
          </>
        )}
      </dl>
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

      <h3>
        {flight.airline?.name ?? flight.number} · {flight.number}
      </h3>
      <p className="status-badge">{flight.status}</p>

      <div className="movements">
        <MovementBlock title="Departure" movement={flight.departure} />
        <MovementBlock title="Arrival" movement={flight.arrival} />
      </div>

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
            {flight.location.altitudeFt ? `${Math.round(flight.location.altitudeFt)} ft` : "—"}
            {" · "}
            {flight.location.groundSpeedKt ? `${Math.round(flight.location.groundSpeedKt)} kt` : "—"}
          </p>
        </div>
      )}
    </div>
  );
}

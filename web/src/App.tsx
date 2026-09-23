import { lazy, Suspense, useEffect, useRef, useState } from "react";
import SearchBar from "./components/SearchBar";
import DetailsPanel from "./components/DetailsPanel";
import { fetchFlightByNumber, ApiError } from "./api";
import type { FlightResult } from "./types";
import "./App.css";

// maplibre-gl is the bulk of the JS bundle; split it into its own chunk instead
// of shipping it in the initial page load.
const FlightMap = lazy(() => import("./components/FlightMap"));

// Matches .details-panel's width and the breakpoint where it goes full-screen (App.css).
const DETAILS_PANEL_WIDTH = 380;
const FULLSCREEN_PANEL_QUERY = "(max-width: 520px)";

// Re-renders so time-derived UI (estimated position, progress, "X ago" labels) keeps moving.
const CLOCK_TICK_MS = 30_000;
// How often an active flight is re-fetched from the server (one AeroDataBox call each).
const REFRESH_INTERVAL_MS = 60_000;
const FINAL_STATUSES = new Set(["Arrived", "Canceled", "CanceledUncertain"]);
// Start refreshing this long before departure, and give up this long after arrival
// if the status never reaches a final one.
const REFRESH_WINDOW_MS = 60 * 60_000;

function parseUtc(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function shouldAutoRefresh(flight: FlightResult, now: number): boolean {
  if (FINAL_STATUSES.has(flight.status)) return false;
  const arr = parseUtc(flight.arrival.revisedUtc ?? flight.arrival.scheduledUtc);
  if (arr !== null && now - arr > REFRESH_WINDOW_MS) return false;
  if (flight.location) return true;
  const dep = parseUtc(flight.departure.revisedUtc ?? flight.departure.scheduledUtc);
  return dep !== null && dep - now < REFRESH_WINDOW_MS;
}

/** Identifies one leg across refreshes, since a flight number can cover several days' legs. */
function flightKey(flight: FlightResult): string {
  return `${flight.number}|${flight.departure.scheduledUtc ?? ""}`;
}

export default function App() {
  const [flights, setFlights] = useState<FlightResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  // The query as typed, reused for refreshes, and a counter so a refresh that
  // lands after a newer search is dropped instead of overwriting it.
  const searchRef = useRef({ query: "", id: 0 });
  const lastUpdatedRef = useRef(0);

  const selectedFlight = flights[selectedIndex] ?? null;

  useEffect(() => {
    const id = setInterval(() => setClockMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedFlight || !shouldAutoRefresh(selectedFlight, Date.now())) return;
    const { query, id: searchId } = searchRef.current;
    const key = flightKey(selectedFlight);

    async function refresh() {
      if (document.hidden) return;
      try {
        const results = await fetchFlightByNumber(query);
        if (searchRef.current.id !== searchId) return;
        const index = results.findIndex((f) => flightKey(f) === key);
        if (index === -1) return;
        const now = Date.now();
        lastUpdatedRef.current = now;
        setLastUpdatedMs(now);
        setFlights(results);
        setSelectedIndex(index);
      } catch {
        // Keep showing the last good data; the "Updated X ago" label shows it aging.
      }
    }

    const intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
    // Hidden tabs skip refreshes, so catch up straight away when the tab comes back.
    const onVisibilityChange = () => {
      if (!document.hidden && Date.now() - lastUpdatedRef.current >= REFRESH_INTERVAL_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [selectedFlight]);

  async function handleSearch(flightNumber: string) {
    const searchId = searchRef.current.id + 1;
    searchRef.current = { query: flightNumber, id: searchId };
    setLoading(true);
    setError(null);
    setSuccess(null);
    setShowDetails(false);
    try {
      const results = await fetchFlightByNumber(flightNumber);
      if (searchRef.current.id !== searchId) return;
      const now = Date.now();
      lastUpdatedRef.current = now;
      setLastUpdatedMs(now);
      if (results.length === 0) {
        setFlights([]);
        setError(`No flights found for "${flightNumber}".`);
      } else {
        setFlights(results);
        setSelectedIndex(0);
        // On phones the panel covers the whole map, so leave it to the user to open.
        setShowDetails(!window.matchMedia(FULLSCREEN_PANEL_QUERY).matches);
        setSuccess(
          results.length === 1
            ? `Found flight ${results[0].number}.`
            : `Found ${results.length} flights for ${flightNumber}.`
        );
      }
    } catch (err) {
      if (searchRef.current.id !== searchId) return;
      setFlights([]);
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <Suspense fallback={<div className="map-loading">Loading map...</div>}>
        <FlightMap
          flight={selectedFlight}
          clockMs={clockMs}
          rightInset={showDetails ? DETAILS_PANEL_WIDTH : 0}
          onMarkerClick={() => setShowDetails(true)}
        />
      </Suspense>

      <div className="overlay top">
        <h1>Interactive Flight</h1>
        <SearchBar onSearch={handleSearch} loading={loading} />
        {error && <p className="error-text">{error}</p>}
        {success && <p className="success-text">{success}</p>}
        {flights.length > 1 && (
          <div className="flight-picker">
            {flights.map((f, i) => (
              <button
                key={`${f.number}-${f.departure.scheduledUtc ?? i}`}
                className={i === selectedIndex ? "active" : ""}
                onClick={() => setSelectedIndex(i)}
              >
                {f.departure.airport.iata ?? "?"} → {f.arrival.airport.iata ?? "?"} ·{" "}
                {f.departure.scheduledLocal?.slice(0, 10) ?? "unknown date"}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedFlight && !showDetails && (
        <button className="hint-pill" onClick={() => setShowDetails(true)}>
          Click the plane on the map for details
        </button>
      )}

      {selectedFlight && showDetails && (
        <DetailsPanel flight={selectedFlight} lastUpdatedMs={lastUpdatedMs} onClose={() => setShowDetails(false)} />
      )}
    </div>
  );
}

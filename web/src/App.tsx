import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import SearchBar from "./components/SearchBar";
import DetailsPanel from "./components/DetailsPanel";
import { fetchFlightByNumber, ApiError } from "./api";
import { flightPhase, latestEstimateUtc, parseApiTime } from "./flightStatus";
import type { FlightResult } from "./types";
import "./App.css";

// maplibre-gl is the bulk of the JS bundle; split it into its own chunk instead
// of shipping it in the initial page load.
const FlightMap = lazy(() => import("./components/FlightMap"));

// Match .details-panel's width and the phone breakpoint where it becomes a bottom sheet (App.css).
const DETAILS_PANEL_WIDTH = 380;
const SHEET_QUERY = "(max-width: 520px)";

// Re-renders so time-derived UI (estimated position, progress, "X ago" labels) keeps moving.
const CLOCK_TICK_MS = 30_000;
// How often an active flight is re-fetched from the server (one AeroDataBox call each).
const REFRESH_INTERVAL_MS = 60_000;
const FINAL_STATUSES = new Set(["Arrived", "Canceled", "CanceledUncertain"]);
// Start refreshing this long before departure, and give up this long after arrival
// if the status never reaches a final one.
const REFRESH_WINDOW_MS = 60 * 60_000;

function shouldAutoRefresh(flight: FlightResult, now: number): boolean {
  if (FINAL_STATUSES.has(flight.status)) return false;
  const arr = parseApiTime(latestEstimateUtc(flight.arrival));
  if (arr !== null && now - arr > REFRESH_WINDOW_MS) return false;
  if (flight.location) return true;
  const dep = parseApiTime(latestEstimateUtc(flight.departure));
  return dep !== null && dep - now < REFRESH_WINDOW_MS;
}

/** Identifies one leg across refreshes, since a flight number can cover several days' legs. */
function flightKey(flight: FlightResult): string {
  return `${flight.number}|${flight.departure.scheduledUtc ?? ""}`;
}

/** Prefers the leg currently in the air; falls back to the first result otherwise. */
function defaultResultIndex(results: FlightResult[]): number {
  const airborneIndex = results.findIndex((f) => flightPhase(f) === "airborne");
  return airborneIndex === -1 ? 0 : airborneIndex;
}

const PHASE_LABELS: Partial<Record<ReturnType<typeof flightPhase>, string>> = {
  airborne: "in the air",
  landed: "landed",
  "pre-departure": "scheduled",
  canceled: "canceled",
  diverted: "diverted",
};

/** "EWR → SIN · Wed, Sep 23 · in the air": enough to tell a flight number's legs apart. */
function legLabel(flight: FlightResult): string {
  const ymd = flight.departure.scheduledLocal?.slice(0, 10);
  const date = ymd ? new Date(`${ymd}T00:00:00Z`) : null;
  const day =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
      : "date unknown";
  const route = `${flight.departure.airport.iata ?? "?"} → ${flight.arrival.airport.iata ?? "?"}`;
  const phase = PHASE_LABELS[flightPhase(flight)];
  return [route, day, phase].filter(Boolean).join(" · ");
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
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
  // The query behind the flights on screen, reused for refreshes, and a generation bumped
  // per successful search so a refresh that lands after newer results is dropped. A failed
  // search leaves both alone, so the flight already on screen keeps refreshing.
  const shownRef = useRef({ query: "", generation: 0 });
  const [resultGeneration, setResultGeneration] = useState(0);
  // Bumped per search, so a slow response to an older search is dropped.
  const searchIdRef = useRef(0);
  const lastUpdatedRef = useRef(0);

  const isSheet = useMediaQuery(SHEET_QUERY);
  const [sheetPeekHeight, setSheetPeekHeight] = useState(0);
  // The search card sits over the map's top-left corner; framing keeps the route below it.
  const searchCardRef = useRef<HTMLDivElement | null>(null);
  const [searchCardBottom, setSearchCardBottom] = useState(0);
  // Bumped per pick in the flight picker, so switching between results always re-frames
  // (results can share a flight number and lack a UTC time, which would otherwise look identical).
  const [pickCount, setPickCount] = useState(0);
  const closeDetails = useCallback(() => setShowDetails(false), []);

  const selectedFlight = flights[selectedIndex] ?? null;
  const autoRefresh = selectedFlight !== null && shouldAutoRefresh(selectedFlight, clockMs);
  const mapInsets = {
    top: searchCardBottom,
    right: showDetails && !isSheet ? DETAILS_PANEL_WIDTH : 0,
    bottom: showDetails && isSheet ? sheetPeekHeight : 0,
  };

  useEffect(() => {
    const card = searchCardRef.current;
    if (!card) return;
    const observer = new ResizeObserver(() => setSearchCardBottom(Math.ceil(card.getBoundingClientRect().bottom)));
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setClockMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedFlight || !shouldAutoRefresh(selectedFlight, Date.now())) return;
    const { query, generation } = shownRef.current;
    const key = flightKey(selectedFlight);

    async function refresh() {
      if (document.hidden) return;
      try {
        const results = await fetchFlightByNumber(query);
        if (shownRef.current.generation !== generation) return;
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

  // A miss or failure keeps whatever flight is already on screen; only a successful
  // search replaces it.
  async function handleSearch(flightNumber: string) {
    searchIdRef.current += 1;
    const searchId = searchIdRef.current;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const results = await fetchFlightByNumber(flightNumber);
      if (searchIdRef.current !== searchId) return;
      if (results.length === 0) {
        setError(`No flights found for ${flightNumber}. Check the airline code and number.`);
        return;
      }
      const generation = shownRef.current.generation + 1;
      shownRef.current = { query: flightNumber, generation };
      setResultGeneration(generation);
      const now = Date.now();
      lastUpdatedRef.current = now;
      setLastUpdatedMs(now);
      setFlights(results);
      setSelectedIndex(defaultResultIndex(results));
      setShowDetails(true);
      setSuccess(
        results.length === 1
          ? `Found flight ${results[0].number}.`
          : `Found ${results.length} flights for ${flightNumber}.`
      );
    } catch (err) {
      if (searchIdRef.current !== searchId) return;
      setError(err instanceof ApiError ? err.message : "Something went wrong looking up that flight. Try again.");
    } finally {
      if (searchIdRef.current === searchId) setLoading(false);
    }
  }

  return (
    <main className="app" style={
        {
          "--map-inset-top": `${mapInsets.top}px`,
          "--map-inset-right": `${mapInsets.right}px`,
          "--map-inset-bottom": `${mapInsets.bottom}px`,
        } as CSSProperties
      }>
      <Suspense fallback={<div className="map-loading">Loading map…</div>}>
        <FlightMap
          flight={selectedFlight}
          clockMs={clockMs}
          insets={mapInsets}
          framingKey={`${resultGeneration}-${pickCount}`}
          onMarkerClick={() => setShowDetails(true)}
        />
      </Suspense>

      <div className="overlay top" ref={searchCardRef}>
        <h1>Flightpath</h1>
        <SearchBar onSearch={handleSearch} loading={loading} />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {/* Always rendered, so screen readers are listening before the message appears. */}
        <div aria-live="polite">{success && <p className="success-text">{success}</p>}</div>
        {flights.length > 1 && (
          <div className="flight-picker">
            {flights.map((f, i) => (
              <button
                key={`${f.number}-${f.departure.scheduledUtc ?? i}`}
                className={i === selectedIndex ? "active" : ""}
                aria-pressed={i === selectedIndex}
                onClick={() => {
                  setSelectedIndex(i);
                  setPickCount((n) => n + 1);
                }}
              >
                {legLabel(f)}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedFlight && !showDetails && (
        <button className="hint-pill" onClick={() => setShowDetails(true)}>
          Show flight details
        </button>
      )}

      {selectedFlight && showDetails && (
        <DetailsPanel
          // Remounts per new search (moving focus to the new flight), not per pick or refresh.
          key={resultGeneration}
          flight={selectedFlight}
          lastUpdatedMs={lastUpdatedMs}
          autoRefresh={autoRefresh}
          variant={isSheet ? "sheet" : "side"}
          onPeekHeightChange={setSheetPeekHeight}
          onClose={closeDetails}
        />
      )}
    </main>
  );
}

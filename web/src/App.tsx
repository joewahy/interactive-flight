import { lazy, Suspense, useState } from "react";
import SearchBar from "./components/SearchBar";
import DetailsPanel from "./components/DetailsPanel";
import { fetchFlightByNumber, ApiError } from "./api";
import type { FlightResult } from "./types";
import "./App.css";

// three.js is the bulk of the JS bundle; split it into its own chunk instead
// of shipping it in the initial page load.
const FlightGlobe = lazy(() => import("./components/FlightGlobe"));

export default function App() {
  const [flights, setFlights] = useState<FlightResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const selectedFlight = flights[selectedIndex] ?? null;

  async function handleSearch(flightNumber: string) {
    setLoading(true);
    setError(null);
    setSuccess(null);
    setShowDetails(false);
    try {
      const results = await fetchFlightByNumber(flightNumber);
      if (results.length === 0) {
        setFlights([]);
        setError(`No flights found for "${flightNumber}".`);
      } else {
        setFlights(results);
        setSelectedIndex(0);
        setSuccess(
          results.length === 1
            ? `Found flight ${results[0].number}.`
            : `Found ${results.length} flights for ${flightNumber}.`
        );
      }
    } catch (err) {
      setFlights([]);
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <Suspense fallback={<div className="globe-loading">Loading globe...</div>}>
        <FlightGlobe flight={selectedFlight} onMarkerClick={() => setShowDetails(true)} />
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
                onClick={() => {
                  setSelectedIndex(i);
                  setShowDetails(false);
                }}
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
          Click the plane on the globe for details
        </button>
      )}

      {selectedFlight && showDetails && (
        <DetailsPanel flight={selectedFlight} onClose={() => setShowDetails(false)} />
      )}
    </div>
  );
}

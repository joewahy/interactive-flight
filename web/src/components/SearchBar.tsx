import { useId, useState, type FormEvent } from "react";

interface Props {
  onSearch: (flightNumber: string) => void;
  loading: boolean;
}

// An airline code (two-character IATA like "BA" or "9W", or three-letter ICAO like "BAW")
// then a 1-4 digit number, with an optional letter suffix. Checked before searching so a
// typo gets a hint here instead of spending a paid API call on a certain miss.
const FLIGHT_NUMBER = /^([A-Z]{3}|[A-Z0-9]{2})\d{1,4}[A-Z]?$/;

export default function SearchBar({ onSearch, loading }: Props) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const hintId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const flightNumber = value.replace(/\s+/g, "");
    if (!flightNumber) return;
    if (!FLIGHT_NUMBER.test(flightNumber)) {
      setInvalid(true);
      return;
    }
    onSearch(flightNumber);
  }

  return (
    <form className="search-bar" onSubmit={handleSubmit} noValidate>
      <label className="search-label" htmlFor={inputId}>
        Flight number
      </label>
      <div className="search-row">
        <input
          id={inputId}
          type="text"
          aria-invalid={invalid}
          aria-describedby={invalid ? hintId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. BA123"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase());
            setInvalid(false);
          }}
          autoFocus
        />
        <button type="submit" disabled={loading || !value.trim()}>
          {loading ? "Searching…" : "Track"}
        </button>
      </div>
      {invalid && (
        <p id={hintId} className="field-hint" role="alert">
          That doesn't look like a flight number. Use the airline code and number, like BA123 or UAL1.
        </p>
      )}
    </form>
  );
}

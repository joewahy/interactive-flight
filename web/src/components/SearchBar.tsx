import { useState, type FormEvent } from "react";

interface Props {
  onSearch: (flightNumber: string) => void;
  loading: boolean;
}

export default function SearchBar({ onSearch, loading }: Props) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSearch(trimmed);
  }

  return (
    <form className="search-bar" onSubmit={handleSubmit}>
      <input
        type="text"
        aria-label="Flight number"
        autoComplete="off"
        spellCheck={false}
        placeholder="Flight number, e.g. BA123"
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        autoFocus
      />
      <button type="submit" disabled={loading || !value.trim()}>
        {loading ? "Searching…" : "Track"}
      </button>
    </form>
  );
}

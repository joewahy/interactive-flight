import type { FlightResult } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

export class ApiError extends Error {}

export async function fetchFlightByNumber(number: string): Promise<FlightResult[]> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/flight/${encodeURIComponent(number)}`);
  } catch {
    throw new ApiError("Can't reach the flight server. Check that it's running (npm run dev), then try again.");
  }
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(data.error ?? `The flight server returned an error (${res.status}). Try again.`);
  }

  return data.flights as FlightResult[];
}

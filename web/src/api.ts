import type { FlightResult } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

export class ApiError extends Error {}

export async function fetchFlightByNumber(number: string): Promise<FlightResult[]> {
  const res = await fetch(`${API_BASE}/api/flight/${encodeURIComponent(number)}`);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(data.error ?? `Request failed (${res.status})`);
  }

  return data.flights as FlightResult[];
}

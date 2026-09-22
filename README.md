# interactive-flight

Enter a flight number, see it tracked live on a map: the flown portion of its
route, current position (or a best-effort estimate when live position isn't
reported), a hover tooltip with the flight number, and a click-through
details panel with an aircraft photo, route/timing progress, and
departure/arrival weather.

## Setup

1. Get a free [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) API key via RapidAPI.
2. Copy `server/.env.example` to `server/.env` and fill in `AERODATABOX_RAPIDAPI_KEY`.
3. Install dependencies:
   ```bash
   npm install --prefix server
   npm install --prefix web
   ```
4. Run everything:
   ```bash
   npm run dev
   ```
   This starts the API proxy on `http://localhost:8787` and the web app on
   `http://localhost:5173`.

## How it works

- `web/` (Vite + React + TypeScript): map rendered with `maplibre-gl` on a
  free CARTO basemap (admin boundaries and labels come from the basemap
  itself, not a separate data layer).
- `server/` (Express): proxies AeroDataBox so the API key never reaches the
  browser. Weather is fetched client-side from Open-Meteo (no key required).
- When a flight has no live ADS-B position reported, the plane's position is
  estimated by interpolating along the great-circle route based on elapsed
  time between scheduled/revised departure and arrival.

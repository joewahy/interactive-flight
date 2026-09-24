import "dotenv/config";
import express from "express";
import cors from "cors";
import { fetchFlightsByNumber, AeroDataBoxError } from "./aerodatabox.js";

const app = express();
const PORT = process.env.FLIGHT_SERVER_PORT ? Number(process.env.FLIGHT_SERVER_PORT) : 8787;
const API_KEY = process.env.AERODATABOX_RAPIDAPI_KEY;

app.use(cors());

function describeUpstreamError(upstreamStatus: number): { status: number; error: string } {
  if (upstreamStatus === 400) {
    return { status: 400, error: "The flight data service didn't recognize that flight number. Check the airline code and number." };
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return { status: 502, error: "The flight data service rejected the API key. Check AERODATABOX_RAPIDAPI_KEY in server/.env." };
  }
  if (upstreamStatus === 429) {
    return { status: 429, error: "The flight data service's request limit was reached. Wait a minute, then try again." };
  }
  return { status: 502, error: "The flight data service isn't responding properly right now. Try again in a minute." };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY) });
});

app.get("/api/flight/:number", async (req, res) => {
  if (!API_KEY) {
    res.status(500).json({
      error: "Server is missing AERODATABOX_RAPIDAPI_KEY. Add it to server/.env.",
    });
    return;
  }

  const flightNumber = req.params.number.trim();
  if (!flightNumber) {
    res.status(400).json({ error: "Flight number is required." });
    return;
  }

  try {
    const flights = await fetchFlightsByNumber(API_KEY, flightNumber);
    res.json({ flights });
  } catch (err) {
    if (err instanceof AeroDataBoxError) {
      // The raw upstream body is for the server log; the app shows a plain-language
      // message with a next step instead.
      console.error(`AeroDataBox ${err.status}: ${err.message}`);
      const { status, error } = describeUpstreamError(err.status);
      res.status(status).json({ error });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(PORT, () => {
  console.log(`interactive-flight server listening on http://localhost:${PORT}`);
});

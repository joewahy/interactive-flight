import "dotenv/config";
import express from "express";
import cors from "cors";
import { fetchFlightsByNumber, AeroDataBoxError } from "./aerodatabox.js";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const API_KEY = process.env.AERODATABOX_RAPIDAPI_KEY;

app.use(cors());

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
      res.status(err.status === 401 || err.status === 403 ? 502 : err.status).json({
        error: `AeroDataBox request failed: ${err.message}`,
      });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(PORT, () => {
  console.log(`interactive-flight server listening on http://localhost:${PORT}`);
});

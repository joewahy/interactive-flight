export interface WeatherSnapshot {
  temperatureC: number;
  windSpeedKmh: number;
  weatherCode: number;
  isDay: boolean;
}

// WMO weather interpretation codes used by Open-Meteo.
const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? "Unknown conditions";
}

export async function fetchWeather(lat: number, lon: number): Promise<WeatherSnapshot | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,wind_speed_10m,weather_code,is_day");

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const current = data.current;
  if (!current) return null;

  return {
    temperatureC: current.temperature_2m,
    windSpeedKmh: current.wind_speed_10m,
    weatherCode: current.weather_code,
    isDay: Boolean(current.is_day),
  };
}

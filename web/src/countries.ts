// Natural Earth 1:110m admin-0 country boundaries, re-hosted by the globe.gl project
// (the same dataset its own official polygon examples use).
const COUNTRIES_URL =
  "https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson";

export interface CountryProperties {
  NAME: string;
  CONTINENT: string;
  SUBREGION: string;
  POP_EST: number;
}

export interface CountryFeature {
  type: "Feature";
  properties: CountryProperties;
  geometry: { type: string; coordinates: unknown };
}

export async function fetchCountries(): Promise<CountryFeature[]> {
  const res = await fetch(COUNTRIES_URL);
  if (!res.ok) return [];
  const data = await res.json();
  return data.features as CountryFeature[];
}

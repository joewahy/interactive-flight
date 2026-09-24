export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Interpolates a point along the great-circle path between two coordinates. f is in [0, 1]. */
export function greatCircleInterpolate(start: LatLon, end: LatLon, f: number): LatLon {
  const phi1 = toRad(start.lat);
  const lambda1 = toRad(start.lon);
  const phi2 = toRad(end.lat);
  const lambda2 = toRad(end.lon);

  const cosPhi1 = Math.cos(phi1);
  const cosPhi2 = Math.cos(phi2);

  const deltaPhi = phi2 - phi1;
  const deltaLambda = lambda2 - lambda1;
  const a =
    Math.sin(deltaPhi / 2) ** 2 + cosPhi1 * cosPhi2 * Math.sin(deltaLambda / 2) ** 2;
  const delta = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  if (delta === 0) return { lat: start.lat, lon: start.lon };

  const A = Math.sin((1 - f) * delta) / Math.sin(delta);
  const B = Math.sin(f * delta) / Math.sin(delta);

  const x = A * cosPhi1 * Math.cos(lambda1) + B * cosPhi2 * Math.cos(lambda2);
  const y = A * cosPhi1 * Math.sin(lambda1) + B * cosPhi2 * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);

  const phi = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lambda = Math.atan2(y, x);

  return { lat: toDeg(phi), lon: toDeg(lambda) };
}

/** Great-circle (haversine) angle between two coordinates, in radians. */
export function angularDistance(start: LatLon, end: LatLon): number {
  const deltaPhi = toRad(end.lat - start.lat);
  const deltaLambda = toRad(end.lon - start.lon);
  const a =
    Math.sin(deltaPhi / 2) ** 2 + Math.cos(toRad(start.lat)) * Math.cos(toRad(end.lat)) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The point reached from start along a compass bearing (degrees) after an angular distance (radians). */
export function destinationPoint(start: LatLon, bearingDeg: number, angle: number): LatLon {
  const phi1 = toRad(start.lat);
  const lambda1 = toRad(start.lon);
  const theta = toRad(bearingDeg);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(angle) + Math.cos(phi1) * Math.sin(angle) * Math.cos(theta));
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * Math.sin(angle) * Math.cos(phi1), Math.cos(angle) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: toDeg(phi2), lon: toDeg(lambda2) };
}

/** Initial compass bearing (degrees, 0-360) from start to end. */
export function initialBearing(start: LatLon, end: LatLon): number {
  const phi1 = toRad(start.lat);
  const phi2 = toRad(end.lat);
  const deltaLambda = toRad(end.lon - start.lon);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

import { useEffect, useMemo, useRef } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import type { FlightResult } from "../types";
import { getFlightPosition } from "../flightPosition";

const GLOBE_IMAGE_URL = "//unpkg.com/three-globe/example/img/earth-night.jpg";
const BUMP_IMAGE_URL = "//unpkg.com/three-globe/example/img/earth-topology.png";
const BACKGROUND_IMAGE_URL = "//unpkg.com/three-globe/example/img/night-sky.png";

interface AirportPoint {
  lat: number;
  lng: number;
  label: string;
  color: string;
}

interface PlaneMarker {
  lat: number;
  lng: number;
  headingDeg: number;
  isLive: boolean;
  flightNumber: string;
}

interface Props {
  flight: FlightResult | null;
  onMarkerClick: () => void;
}

function planeIconSvg(color: string): string {
  return `
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2 L14 9 L21 13 L21 15 L14 13 L13 20 L16 22 L16 23 L12 22 L8 23 L8 22 L11 20 L10 13 L3 15 L3 13 L10 9 Z"
        fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.5" />
    </svg>
  `;
}

export default function FlightGlobe({ flight, onMarkerClick }: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const hasFramedFlight = useRef<string | null>(null);

  const position = useMemo(() => (flight ? getFlightPosition(flight) : null), [flight]);

  const arcsData = useMemo(() => {
    if (!flight) return [];
    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;
    if (dep.lat === null || dep.lon === null || arr.lat === null || arr.lon === null) return [];
    return [
      {
        startLat: dep.lat,
        startLng: dep.lon,
        endLat: arr.lat,
        endLng: arr.lon,
      },
    ];
  }, [flight]);

  const pointsData = useMemo<AirportPoint[]>(() => {
    if (!flight) return [];
    const points: AirportPoint[] = [];
    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;
    if (dep.lat !== null && dep.lon !== null) {
      points.push({
        lat: dep.lat,
        lng: dep.lon,
        label: dep.iata ?? dep.icao ?? dep.name,
        color: "#4fd1ff",
      });
    }
    if (arr.lat !== null && arr.lon !== null) {
      points.push({
        lat: arr.lat,
        lng: arr.lon,
        label: arr.iata ?? arr.icao ?? arr.name,
        color: "#ff6b6b",
      });
    }
    return points;
  }, [flight]);

  const htmlElementsData = useMemo<PlaneMarker[]>(() => {
    if (!flight || !position) return [];
    return [
      {
        lat: position.lat,
        lng: position.lon,
        headingDeg: position.headingDeg,
        isLive: position.isLive,
        flightNumber: flight.number,
      },
    ];
  }, [flight, position]);

  useEffect(() => {
    if (!flight || !globeRef.current) return;
    if (hasFramedFlight.current === flight.number) return;
    hasFramedFlight.current = flight.number;

    const dep = flight.departure.airport;
    const arr = flight.arrival.airport;
    const lat = position?.lat ?? dep.lat ?? arr.lat ?? 0;
    const lng = position?.lon ?? dep.lon ?? arr.lon ?? 0;
    globeRef.current.pointOfView({ lat, lng, altitude: 1.8 }, 1200);
  }, [flight, position]);

  return (
    <Globe
      ref={globeRef}
      globeImageUrl={GLOBE_IMAGE_URL}
      bumpImageUrl={BUMP_IMAGE_URL}
      backgroundImageUrl={BACKGROUND_IMAGE_URL}
      arcsData={arcsData}
      arcColor={() => ["rgba(79, 209, 255, 0.9)", "rgba(79, 209, 255, 0.2)"]}
      arcDashLength={0.4}
      arcDashGap={0.2}
      arcDashAnimateTime={2500}
      arcStroke={0.6}
      arcAltitudeAutoScale={0.35}
      pointsData={pointsData}
      pointLat="lat"
      pointLng="lng"
      pointColor="color"
      pointRadius={0.35}
      pointAltitude={0.005}
      pointLabel={(d) => (d as AirportPoint).label}
      htmlElementsData={htmlElementsData}
      htmlLat="lat"
      htmlLng="lng"
      htmlAltitude={0.02}
      htmlElement={(d) => {
        const marker = d as PlaneMarker;

        // react-globe.gl owns `transform` and `pointer-events` on this root element
        // (it overwrites them every frame to keep the marker screen-projected), so
        // rotation, hit-testing and event listeners all have to live on a child instead.
        const wrapper = document.createElement("div");
        wrapper.style.cssText = `width: 0; height: 0;`;

        const content = document.createElement("div");
        content.style.cssText = `
          position: relative;
          width: 30px;
          height: 30px;
          cursor: pointer;
          pointer-events: auto;
          transform: translate(-50%, -50%) rotate(${marker.headingDeg}deg);
          filter: drop-shadow(0 0 6px ${marker.isLive ? "#4fd1ff" : "rgba(255,255,255,0.5)"});
        `;
        content.innerHTML = planeIconSvg(marker.isLive ? "#4fd1ff" : "#c9cdda");
        wrapper.appendChild(content);

        const tooltip = document.createElement("div");
        tooltip.textContent = marker.flightNumber;
        tooltip.style.cssText = `
          position: absolute;
          left: 50%;
          bottom: 130%;
          transform: translateX(-50%) rotate(${-marker.headingDeg}deg);
          background: rgba(10, 12, 20, 0.9);
          color: #fff;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-family: sans-serif;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.15s ease;
        `;
        content.appendChild(tooltip);

        content.addEventListener("mouseenter", () => {
          tooltip.style.opacity = "1";
        });
        content.addEventListener("mouseleave", () => {
          tooltip.style.opacity = "0";
        });
        content.addEventListener("click", (event) => {
          event.stopPropagation();
          onMarkerClick();
        });

        return wrapper;
      }}
    />
  );
}

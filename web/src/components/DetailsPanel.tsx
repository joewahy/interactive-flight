import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { Airport, FlightResult, Movement } from "../types";
import { describeWeatherCode, fetchWeather, type WeatherSnapshot } from "../weather";
import { getFlightProgress } from "../flightPosition";
import {
  delayMinutes,
  delayTone,
  describeDelay,
  formatAirportTime,
  formatDuration,
  localDayOffset,
  movementTime,
  parseApiTime,
  summarizeStatus,
  type StatusSummary,
} from "../flightStatus";
import { planeIconSvg } from "../planeIcon";

interface Props {
  flight: FlightResult;
  lastUpdatedMs: number | null;
  /** Whether the flight is still being re-fetched on a timer (so "Updated X ago" is meaningful). */
  autoRefresh: boolean;
  /** "side" docks to the right edge; "sheet" is the phone bottom sheet with a collapsed peek state. */
  variant: "side" | "sheet";
  /** Reports the sheet's collapsed height, so the map can keep the route clear of it. */
  onPeekHeightChange?: (height: number) => void;
  onClose: () => void;
}

/** The airport's own local timezone label (e.g. "PDT (GMT-7)"), independent of the viewer's. */
function formatTimeZoneLabel(timeZone: string | null, atUtc: string | null): string | null {
  if (!timeZone) return null;
  const date = new Date(parseApiTime(atUtc) ?? Date.now());
  try {
    const abbrev = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    if (abbrev && offset && abbrev !== offset) return `${abbrev} (${offset})`;
    return abbrev ?? offset ?? null;
  } catch {
    return null;
  }
}

/** "just now", "12 min ago", or "1 h 5 min ago". */
function formatAgo(ms: number): string {
  return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString()} km`;
}

function movementMeta(movement: Movement): string | null {
  const parts = [
    movement.terminal ? `Terminal ${movement.terminal}` : null,
    movement.gate ? `Gate ${movement.gate}` : null,
    movement.baggageBelt ? `Belt ${movement.baggageBelt}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "YYYY-MM-DD" as a calendar date, read in UTC so it can't shift a day in the viewer's zone. */
function formatCalendarDate(ymd: string | null): string | null {
  if (!ymd) return null;
  const date = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Below these, a pointer's up/down movement on the sheet handle is read as a tap, not a swipe.
const SHEET_DRAG_MOVE_PX = 6;
const SHEET_DRAG_DISTANCE_PX = 24;
const SHEET_DRAG_VELOCITY = 0.3; // px/ms

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function compassPoint(deg: number): string {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

type AircraftDetails = NonNullable<NonNullable<FlightResult["aircraft"]>["details"]>;

/** e.g. "12.5 years old · 102 seats · 2 jet engines", skipping whatever's unknown. */
function aircraftFacts(details: AircraftDetails): string | null {
  const engines =
    details.numEngines !== null
      ? `${details.numEngines} ${details.engineType ? `${details.engineType.toLowerCase()} ` : ""}engine${details.numEngines === 1 ? "" : "s"}`
      : null;
  const parts = [
    details.ageYears !== null ? `${details.ageYears.toFixed(1)} years old` : null,
    details.numSeats !== null ? `${details.numSeats} seats` : null,
    engines,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function airportCode(airport: Airport): string {
  return airport.iata ?? airport.icao ?? "—";
}

/** "SFO · San Francisco" — keeps the airport identifiable in sections far from the route header. */
function airportLabel(airport: Airport): string {
  return `${airportCode(airport)} · ${airport.municipality ?? airport.name}`;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function StatusBlock({
  status,
  lastUpdatedMs,
  autoRefresh,
}: Pick<Props, "lastUpdatedMs" | "autoRefresh"> & { status: StatusSummary }) {
  return (
    <div className={`status-block tone-${status.tone}`}>
      {/* Polite so a status change from a background refresh is announced, not the every-minute timestamp. */}
      <div aria-live="polite" aria-atomic="true">
        <p className="status-headline">{status.headline}</p>
        {status.detail && <p className="status-detail">{status.detail}</p>}
        {status.action && (
          <p className="status-action">
            <a className="text-button" href={status.action.href} target="_blank" rel="noopener noreferrer">
              {status.action.label}
            </a>
          </p>
        )}
      </div>
      {autoRefresh && lastUpdatedMs !== null && (
        <p className="status-updated">Updates every minute · last {formatAgo(Date.now() - lastUpdatedMs)}</p>
      )}
    </div>
  );
}

function RouteEndpoint({ airport, atUtc, align }: { airport: Airport; atUtc: string | null; align: "start" | "end" }) {
  const tz = formatTimeZoneLabel(airport.timeZone, atUtc);
  return (
    <div className={`route-endpoint ${align}`}>
      <span className="route-code">{airportCode(airport)}</span>
      <span className="route-city">{airport.municipality ?? airport.name}</span>
      {tz && <span className="route-tz">{tz}</span>}
    </div>
  );
}

function RouteHeader({ flight }: { flight: FlightResult }) {
  const depScheduled = parseApiTime(flight.departure.scheduledUtc);
  const arrScheduled = parseApiTime(flight.arrival.scheduledUtc);
  const blockMs = depScheduled !== null && arrScheduled !== null && arrScheduled > depScheduled ? arrScheduled - depScheduled : null;
  const distanceKm = flight.greatCircleDistanceKm;

  return (
    <div className="route-header">
      <RouteEndpoint airport={flight.departure.airport} atUtc={flight.departure.scheduledUtc} align="start" />
      <div className="route-span">
        {blockMs !== null && (
          <span className="route-span-value">
            <span className="sr-only">Scheduled flight time </span>
            {formatDuration(blockMs)}
          </span>
        )}
        <span className="route-span-line" aria-hidden="true" />
        {distanceKm !== null && <span className="route-span-sub">{formatKm(distanceKm)}</span>}
      </div>
      <RouteEndpoint airport={flight.arrival.airport} atUtc={flight.arrival.scheduledUtc} align="end" />
    </div>
  );
}

/**
 * A time with the boarding-pass day marker: "+1" when it falls on a later local date
 * than the scheduled departure, so an overnight arrival doesn't read as the same day.
 */
function TimeWithDay({ flight, movement, utc }: { flight: FlightResult; movement: Movement; utc: string | null }) {
  const dep = flight.departure;
  const offset = localDayOffset(utc, movement.airport.timeZone, dep.scheduledUtc, dep.airport.timeZone);
  return (
    <>
      {formatAirportTime(utc, movement.airport.timeZone)}
      {offset !== null && offset !== 0 && (
        <span className="day-offset">
          {offset > 0 ? `+${offset}` : `−${-offset}`}
          <span className="sr-only">{` day${Math.abs(offset) === 1 ? "" : "s"}`}</span>
        </span>
      )}
    </>
  );
}

function TimeColumn({ flight, which }: { flight: FlightResult; which: "departure" | "arrival" }) {
  const movement = flight[which];
  const current = movementTime(flight, which);
  const delay = delayMinutes(movement);
  const meta = movementMeta(movement);
  const verb = which === "departure" ? "Departure from" : "Arrival at";

  return (
    <div className={`route-times-col ${which === "departure" ? "start" : "end"}`} role="group" aria-label={`${verb} ${airportCode(movement.airport)}`}>
      <span className="route-times-code" aria-hidden="true">
        {airportCode(movement.airport)}
      </span>
      <div className="stat-tile">
        <span className="stat-label">Scheduled</span>
        <span className="stat-value muted">
          <TimeWithDay flight={flight} movement={movement} utc={movement.scheduledUtc} />
        </span>
      </div>
      {current && (
        <div className="stat-tile">
          <span className="stat-label">{current.label}</span>
          <span className="stat-value">
            {current.utc ? <TimeWithDay flight={flight} movement={movement} utc={current.utc} /> : "Not reported"}
          </span>
          {delay !== null && <span className={`stat-delta tone-${delayTone(delay)}`}>{describeDelay(delay)}</span>}
          {meta && <span className="stat-sub">{meta}</span>}
        </div>
      )}
      {!current && meta && <p className="route-meta">{meta}</p>}
    </div>
  );
}

function RouteProgress({ flight }: { flight: FlightResult }) {
  const { fraction, depTimeMs, arrTimeMs, phase } = getFlightProgress(flight);
  if (fraction === null) return null;

  const distanceKm = flight.greatCircleDistanceKm;
  const now = Date.now();
  const hasLeft = phase === "airborne" || phase === "landed";

  const departedLabel =
    depTimeMs === null
      ? null
      : hasLeft
        ? `Departed ${formatAgo(now - depTimeMs)}`
        : depTimeMs > now
          ? `Departs in ${formatDuration(depTimeMs - now)}`
          : `Due to depart ${formatAgo(now - depTimeMs)}`;
  const arrivalLabel =
    arrTimeMs === null
      ? null
      : phase === "landed"
        ? `Landed ${formatAgo(now - arrTimeMs)}`
        : arrTimeMs > now
          ? `Lands in ${formatDuration(arrTimeMs - now)}`
          : `Due to land ${formatAgo(now - arrTimeMs)}`;

  const flownKm = distanceKm !== null ? distanceKm * fraction : null;
  const remainingKm = distanceKm !== null ? distanceKm * (1 - fraction) : null;
  const percent = Math.round(fraction * 100);
  const valueText = remainingKm !== null ? `${percent}% flown, ${formatKm(remainingKm)} to go` : `${percent}% flown`;

  return (
    <div className="route-progress">
      <div
        className="route-progress-track"
        role="progressbar"
        aria-label="Flight progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
      >
        <div className="route-progress-fill" style={{ width: `${fraction * 100}%` }} />
        <div
          className="route-progress-plane"
          style={{ left: `${fraction * 100}%` }}
          dangerouslySetInnerHTML={{ __html: planeIconSvg("currentColor") }}
        />
      </div>
      <div className="route-progress-labels">
        <div>
          {flownKm !== null && <span className="route-progress-km">{formatKm(flownKm)} flown</span>}
          {departedLabel && <span>{departedLabel}</span>}
        </div>
        <div className="end">
          {remainingKm !== null && <span className="route-progress-km">{formatKm(remainingKm)} to go</span>}
          {arrivalLabel && <span>{arrivalLabel}</span>}
        </div>
      </div>
    </div>
  );
}

// Below this, a reported vertical rate is just noise around level flight.
const LEVEL_FLIGHT_FPM = 100;

function LiveStats({ location }: { location: NonNullable<FlightResult["location"]> }) {
  const vs = location.verticalSpeedFpm;
  const vertical =
    vs === null
      ? { label: "Vertical rate", value: "—" }
      : Math.abs(vs) < LEVEL_FLIGHT_FPM
        ? { label: "Vertical rate", value: "Level" }
        : {
            label: vs > 0 ? "Climbing" : "Descending",
            value: `${Math.abs(Math.round(vs)).toLocaleString()} ft/min`,
          };
  const reportedMs = parseApiTime(location.reportedAtUtc);

  const tiles = [
    {
      label: "Altitude",
      value: location.altitudeFt !== null ? `${Math.round(location.altitudeFt).toLocaleString()} ft` : "—",
    },
    {
      label: "Ground speed",
      value: location.groundSpeedKt !== null ? `${Math.round(location.groundSpeedKt)} kt` : "—",
      sub: location.groundSpeedKt !== null ? `${Math.round(location.groundSpeedKt * 1.852)} km/h` : null,
    },
    {
      label: "Heading",
      value: location.trackDeg !== null ? `${Math.round(location.trackDeg)}° ${compassPoint(location.trackDeg)}` : "—",
    },
    vertical,
  ];

  return (
    <section className="section" aria-labelledby="live-heading">
      <h3 id="live-heading">Live position</h3>
      <div className="live-stats">
        {tiles.map((tile) => (
          <div key={tile.label} className="stat-tile">
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{tile.value}</span>
            {"sub" in tile && tile.sub && <span className="stat-sub">{tile.sub}</span>}
          </div>
        ))}
      </div>
      {reportedMs !== null && <p className="section-note">Reported by the aircraft {formatAgo(Date.now() - reportedMs)}</p>}
    </section>
  );
}

function AircraftPhoto({ aircraft }: { aircraft: NonNullable<FlightResult["aircraft"]> }) {
  const image = aircraft.image;
  if (!image) return null;
  return (
    <figure className="aircraft-photo">
      <img src={image.url} alt={aircraft.model ? `A ${aircraft.model}` : "The aircraft"} loading="lazy" />
      {(image.author || image.license) && (
        <figcaption>
          Photo: {image.title && <>“{image.title}”{image.author ? " by " : ""}</>}
          {image.author &&
            (image.pageUrl ? (
              <a href={image.pageUrl} target="_blank" rel="noopener noreferrer">
                {image.author}
              </a>
            ) : (
              image.author
            ))}
          {image.license && (
            <>
              {image.title || image.author ? ", " : ""}
              {image.license.url ? (
                <a href={image.license.url} target="_blank" rel="noopener noreferrer license">
                  {image.license.name}
                </a>
              ) : (
                image.license.name
              )}
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function AircraftSection({ aircraft }: { aircraft: NonNullable<FlightResult["aircraft"]> }) {
  const details = aircraft.details;
  const facts = details ? aircraftFacts(details) : null;
  const firstFlight = details ? formatCalendarDate(details.firstFlightDate) : null;
  const delivered = details ? formatCalendarDate(details.deliveryDate) : null;
  const dates = [firstFlight && `First flew ${firstFlight}`, delivered && `delivered ${delivered}`].filter(Boolean).join(", ");

  if (!aircraft.model && !aircraft.reg && !facts) return null;

  return (
    <section className="section" aria-labelledby="aircraft-heading">
      <h3 id="aircraft-heading">Aircraft</h3>
      {(aircraft.model || aircraft.reg) && (
        <p className="aircraft-name">
          {aircraft.model}
          {aircraft.model && aircraft.reg && " · "}
          {aircraft.reg && <span className="aircraft-reg">{aircraft.reg}</span>}
        </p>
      )}
      {facts && <p>{facts}</p>}
      {dates && <p className="muted">{dates.charAt(0).toUpperCase() + dates.slice(1)}</p>}
    </section>
  );
}

type WeatherState = WeatherSnapshot | null | undefined;

function useAirportWeather(lat: number | null, lon: number | null): [WeatherState, () => void] {
  const [weather, setWeather] = useState<WeatherState>(undefined);
  const [attempt, setAttempt] = useState(0);
  // Retry flips straight to "loading" on click, rather than waiting a render for the effect
  // below to do it, so mashing "Try again" gets an immediate response instead of nothing.
  const retry = useCallback(() => {
    setWeather(undefined);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (lat === null || lon === null) {
      setWeather(null);
      return;
    }
    let current = true;
    setWeather(undefined);
    fetchWeather(lat, lon).then((result) => {
      if (current) setWeather(result);
    });
    return () => {
      current = false;
    };
  }, [lat, lon, attempt]);

  return [weather, retry];
}

function WeatherLine({ label, weather, onRetry }: { label: string; weather: WeatherState; onRetry: () => void }) {
  if (weather === undefined) return <p className="weather-line muted">{label}: loading weather…</p>;
  if (weather === null) {
    return (
      <p className="weather-line">
        {label}: weather couldn't be loaded.{" "}
        <button type="button" className="text-button" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  return (
    <p className="weather-line">
      <span className="weather-code">{label}</span> {Math.round(weather.temperatureC)}°C, {describeWeatherCode(weather.weatherCode).toLowerCase()},{" "}
      {Math.round(weather.windSpeedKmh)} km/h wind
    </p>
  );
}

export default function DetailsPanel({ flight, lastUpdatedMs, autoRefresh, variant, onPeekHeightChange, onClose }: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const peekRef = useRef<HTMLDivElement | null>(null);
  const [peekHeight, setPeekHeight] = useState<number | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const collapsed = variant === "sheet" && !expanded;

  // A swipe on the handle expands/collapses like a native sheet; a plain tap (mouse, touch,
  // or keyboard) still falls through to onClick below. dragged tracks which one happened so
  // the click that follows a swipe's pointerup doesn't also toggle the state a second time.
  const dragStart = useRef<{ y: number; t: number } | null>(null);
  const dragged = useRef(false);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    dragStart.current = { y: event.clientY, t: Date.now() };
    dragged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStart.current && Math.abs(event.clientY - dragStart.current.y) > SHEET_DRAG_MOVE_PX) {
      dragged.current = true;
    }
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start || !dragged.current) return;
    const deltaY = event.clientY - start.y;
    const velocity = deltaY / Math.max(1, Date.now() - start.t);
    if (Math.abs(deltaY) > SHEET_DRAG_DISTANCE_PX || Math.abs(velocity) > SHEET_DRAG_VELOCITY) {
      setExpanded(deltaY < 0);
    }
  }, []);

  const handleClick = useCallback(() => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    setExpanded((e) => !e);
  }, []);

  const [depWeather, retryDepWeather] = useAirportWeather(flight.departure.airport.lat, flight.departure.airport.lon);
  const [arrWeather, retryArrWeather] = useAirportWeather(flight.arrival.airport.lat, flight.arrival.airport.lon);

  // Move focus into the panel when it opens, and hand it back when it closes, so
  // keyboard and screen-reader users land on the result instead of losing their place.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const focusWasInPanel = !active || active === document.body || panelRef.current?.contains(active);
      if (!focusWasInPanel) return;
      let target = opener?.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>(".search-bar input");
      // On a touch screen, focusing the search field would pop up the keyboard just for
      // closing the panel; the button that reopens it is the better landing spot there.
      if (target instanceof HTMLInputElement && window.matchMedia("(pointer: coarse)").matches) {
        target = document.querySelector<HTMLElement>(".hint-pill");
      }
      target?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Collapsing keeps the sheet's scroll at the top, so the peek always shows the status.
  useEffect(() => {
    if (collapsed && panelRef.current) panelRef.current.scrollTop = 0;
  }, [collapsed]);

  // The collapsed sheet shows exactly the header and status block. Their height varies
  // (wrapping detail, the refresh line), so it's measured rather than fixed: the peek ends
  // where the status block does, measured from the top of the sheet.
  useEffect(() => {
    const header = headerRef.current;
    const peek = peekRef.current;
    if (variant !== "sheet" || !header || !peek) return;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(peek.offsetTop + peek.getBoundingClientRect().height);
      setPeekHeight(height);
      onPeekHeightChange?.(height);
    });
    observer.observe(header);
    observer.observe(peek);
    return () => observer.disconnect();
  }, [variant, onPeekHeightChange]);

  const airlineName = flight.airline?.name;
  const status = summarizeStatus(flight);

  return (
    <section
      ref={panelRef}
      className={`details-panel ${variant} tone-${status.tone}${collapsed ? " collapsed" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={variant === "sheet" && peekHeight !== null ? ({ "--peek": `${peekHeight}px` } as CSSProperties) : undefined}
    >
      {/* Pinned to the top of the expanded sheet while its content scrolls, so the handle
          and close button stay in reach. */}
      <div ref={headerRef} className="details-header">
        {variant === "sheet" && (
          <button
            type="button"
            className="sheet-handle"
            aria-expanded={expanded}
            aria-label={expanded ? "Show less" : "Show all flight details"}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={handleClick}
          >
            <span className="sheet-grip" aria-hidden="true" />
            <ChevronIcon />
          </button>
        )}

        <div className="details-top">
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>
            {flight.number}
            {airlineName && <span className="details-airline">{airlineName}</span>}
          </h2>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close flight details">
            <CloseIcon />
          </button>
        </div>
      </div>

      <div ref={peekRef} className="details-peek">
        {/* Sits under the title in the side panel. The phone sheet's peek has no room for
            it, so there it opens the expanded part instead. */}
        {variant === "side" && flight.aircraft && <AircraftPhoto aircraft={flight.aircraft} />}

        <StatusBlock status={status} lastUpdatedMs={lastUpdatedMs} autoRefresh={autoRefresh} />
      </div>

      {/* Below the sheet's peek; inert while collapsed so it's out of the tab order too. */}
      <div className="details-rest" inert={collapsed}>
        {variant === "sheet" && flight.aircraft && <AircraftPhoto aircraft={flight.aircraft} />}
        <RouteHeader flight={flight} />

        <div className="route-times">
          <TimeColumn flight={flight} which="departure" />
          <TimeColumn flight={flight} which="arrival" />
        </div>

        <RouteProgress flight={flight} />

        {flight.location && <LiveStats location={flight.location} />}

        {flight.aircraft && <AircraftSection aircraft={flight.aircraft} />}

        <section className="section" aria-labelledby="weather-heading">
          <h3 id="weather-heading">Weather now</h3>
          <div role="group" aria-label={`Departure weather at ${airportCode(flight.departure.airport)}`}>
            <WeatherLine label={airportLabel(flight.departure.airport)} weather={depWeather} onRetry={retryDepWeather} />
          </div>
          <div role="group" aria-label={`Arrival weather at ${airportCode(flight.arrival.airport)}`}>
            <WeatherLine label={airportLabel(flight.arrival.airport)} weather={arrWeather} onRetry={retryArrWeather} />
          </div>
        </section>
      </div>
    </section>
  );
}

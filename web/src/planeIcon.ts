// Fills whatever box its container sets (see e.g. FlightMap's resizable plane marker
// and DetailsPanel's progress bar) rather than a fixed pixel size of its own.
/** Shared plane glyph: the live/estimated marker on the map and the progress bar marker in the details panel. */
export function planeIconSvg(color: string): string {
  return `
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2 L14 9 L21 13 L21 15 L14 13 L13 20 L16 22 L16 23 L12 22 L8 23 L8 22 L11 20 L10 13 L3 15 L3 13 L10 9 Z"
        fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.5" />
    </svg>
  `;
}

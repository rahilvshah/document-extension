export const LOGO_MAIN_COLOR = '#6366f1';
export const LOGO_STROKE_COLOR = '#ffffff';

// Returns a self-contained SVG string for the DocExt logo.
// `sizePx` controls the rendered width/height.
export function getLogoSvgMarkup(sizePx: number): string {
  const size = Math.max(1, Math.floor(sizePx));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <circle cx="12" cy="12" r="10" fill="${LOGO_MAIN_COLOR}"/>
  <path d="M9 7.5h4a4.5 4.5 0 0 1 0 9H9" fill="none" stroke="${LOGO_STROKE_COLOR}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}


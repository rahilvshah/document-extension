import sharp from 'sharp';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Highlight {
  rect: Rect;
  number?: number;
}

export interface AnnotateOptions {
  highlights: Highlight[];
  viewportWidth: number;
  viewportHeight: number;
  isFirstStep?: boolean;
}

const HIGHLIGHT_COLOR = '#f97316';
const HIGHLIGHT_GLOW = 'rgba(249,115,22,0.3)';
const CIRCLE_RADIUS = 14;

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSingleHighlightSvg(
  h: Highlight,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
  canvasW: number,
  canvasH: number,
): string {
  const pad = 4 * scaleX;
  const r = h.rect;
  const ex = (r.x - offsetX) * scaleX;
  const ey = (r.y - offsetY) * scaleY;
  const ew = r.width * scaleX;
  const eh = r.height * scaleY;

  if (ew < 2 || eh < 2) return '';

  const rx = Math.max(0, ex - pad);
  const ry = Math.max(0, ey - pad);
  const rw = Math.min(canvasW - rx, ew + pad * 2);
  const rh = Math.min(canvasH - ry, eh + pad * 2);
  const radius = 6 * scaleX;
  const lw = 3 * scaleX;

  const parts: string[] = [];

  // Glow border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${escapeXml(HIGHLIGHT_GLOW)}" stroke-width="${lw + 4 * scaleX}"/>`
  );
  // Solid border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw}"/>`
  );

  // Arrow
  const spaceR = canvasW - (rx + rw);
  const spaceL = rx;
  const spaceT = ry;
  const spaceB = canvasH - (ry + rh);
  const best = Math.max(spaceR, spaceL, spaceT, spaceB);

  if (best >= 30 * scaleX) {
    const arrowLen = Math.min(65 * scaleX, best * 0.7);
    const gap = 8 * scaleX;
    let tipX: number, tipY: number, startX: number, startY: number, cpX: number, cpY: number;

    if (best === spaceR) {
      tipX = rx + rw + gap; tipY = ry + rh / 2;
      startX = tipX + arrowLen; startY = tipY - arrowLen * 0.7;
      cpX = startX; cpY = tipY;
    } else if (best === spaceL) {
      tipX = rx - gap; tipY = ry + rh / 2;
      startX = tipX - arrowLen; startY = tipY - arrowLen * 0.7;
      cpX = startX; cpY = tipY;
    } else if (best === spaceT) {
      tipX = rx + rw / 2; tipY = ry - gap;
      startX = tipX + arrowLen * 0.7; startY = tipY - arrowLen;
      cpX = tipX; cpY = startY;
    } else {
      tipX = rx + rw / 2; tipY = ry + rh + gap;
      startX = tipX + arrowLen * 0.7; startY = tipY + arrowLen;
      cpX = tipX; cpY = startY;
    }

    parts.push(
      `<path d="M ${startX},${startY} Q ${cpX},${cpY} ${tipX},${tipY}" ` +
      `fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw}" stroke-linecap="round"/>`
    );

    const headLen = 12 * scaleX;
    const angle = Math.atan2(tipY - cpY, tipX - cpX);
    const p1x = tipX - headLen * Math.cos(angle - 0.45);
    const p1y = tipY - headLen * Math.sin(angle - 0.45);
    const p2x = tipX - headLen * Math.cos(angle + 0.45);
    const p2y = tipY - headLen * Math.sin(angle + 0.45);
    parts.push(
      `<polygon points="${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}" fill="${HIGHLIGHT_COLOR}"/>`
    );
  }

  return parts.join('\n');
}

function buildNumberedHighlightSvg(
  h: Highlight,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
  canvasW: number,
  canvasH: number,
): string {
  const pad = 4 * scaleX;
  const r = h.rect;
  const ex = (r.x - offsetX) * scaleX;
  const ey = (r.y - offsetY) * scaleY;
  const ew = r.width * scaleX;
  const eh = r.height * scaleY;

  if (ew < 2 || eh < 2) return '';

  // Clamp the highlight box so it never extends outside the canvas.
  const rx = Math.max(0, ex - pad);
  const ry = Math.max(0, ey - pad);
  const rw = Math.min(canvasW - rx, ew + pad * 2);
  const rh = Math.min(canvasH - ry, eh + pad * 2);
  const radius = 6 * scaleX;
  const lw = 3 * scaleX;
  const cr = CIRCLE_RADIUS * scaleX;

  const parts: string[] = [];

  // Glow border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${escapeXml(HIGHLIGHT_GLOW)}" stroke-width="${lw + 4 * scaleX}"/>`
  );
  // Solid border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw}"/>`
  );

  // Place the numbered circle at the corner that has the most room.
  // This prevents clipping when the element is near any edge.
  const spaceTop = ry;
  const spaceBottom = canvasH - (ry + rh);
  const spaceRight = canvasW - (rx + rw);

  let circleX: number;
  let circleY: number;

  // Prefer top-right; fall back to bottom-right if near top edge.
  if (spaceTop >= cr * 0.7) {
    // Enough room above — anchor to top-right corner
    circleX = rx + rw - cr * 0.3;
    circleY = ry - cr * 0.7;
  } else if (spaceBottom >= cr * 0.7) {
    // Near top edge — anchor to bottom-right corner
    circleX = rx + rw - cr * 0.3;
    circleY = ry + rh + cr * 0.7;
  } else {
    // No vertical room — float inside the box at top-right
    circleX = rx + rw - cr - lw;
    circleY = ry + cr + lw;
  }

  // If near right edge, shift left
  if (spaceRight < cr * 0.7) {
    circleX = rx + rw - cr - lw;
  }

  // Hard clamp — circle must always be fully inside the canvas
  circleX = Math.min(canvasW - cr - 2, Math.max(cr + 2, circleX));
  circleY = Math.min(canvasH - cr - 2, Math.max(cr + 2, circleY));

  parts.push(
    `<circle cx="${circleX}" cy="${circleY}" r="${cr}" fill="${HIGHLIGHT_COLOR}"/>` +
    `<circle cx="${circleX}" cy="${circleY}" r="${cr + 2 * scaleX}" fill="none" stroke="white" stroke-width="${2 * scaleX}"/>` +
    `<text x="${circleX}" y="${circleY}" dy="0.35em" text-anchor="middle" ` +
    `fill="white" font-size="${cr * 1.2}px" font-weight="bold" font-family="Arial, Helvetica, sans-serif">${h.number}</text>`
  );

  return parts.join('\n');
}

export async function annotateScreenshot(
  rawImageBuffer: Buffer,
  options: AnnotateOptions,
): Promise<Buffer> {
  const { highlights, viewportWidth, viewportHeight } = options;

  if (highlights.length === 0) {
    return sharp(rawImageBuffer).webp({ lossless: true }).toBuffer();
  }

  const metadata = await sharp(rawImageBuffer).metadata();
  const imgW = metadata.width!;
  const imgH = metadata.height!;

  const scaleX = imgW / viewportWidth;
  const scaleY = imgH / viewportHeight;

  // Always annotate the full screenshot — no cropping.
  // offsetX/Y are 0, canvas dimensions match the full image.
  const canvasW = imgW;
  const canvasH = imgH;
  const offsetX = 0;
  const offsetY = 0;

  const isNumbered = highlights.some((h) => h.number != null);

  const svgParts: string[] = [];
  for (const h of highlights) {
    if (isNumbered) {
      svgParts.push(buildNumberedHighlightSvg(h, offsetX, offsetY, scaleX, scaleY, canvasW, canvasH));
    } else {
      svgParts.push(buildSingleHighlightSvg(h, offsetX, offsetY, scaleX, scaleY, canvasW, canvasH));
    }
  }

  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${svgParts.join('')}</svg>`
  );

  return sharp(rawImageBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .webp({ lossless: true })
    .toBuffer();
}

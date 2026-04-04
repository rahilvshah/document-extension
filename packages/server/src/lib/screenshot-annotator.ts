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

  // Arrow — drawn on whichever side has the most room
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

/** Compute candidate circle positions for a box, in preference order. */
function circlePositionCandidates(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  cr: number,
  lw: number,
  canvasW: number,
  canvasH: number,
): Array<{ cx: number; cy: number }> {
  // Fixed priority: outside corners first (top-right preferred), inside as last resort.
  // Order is intentional — do NOT sort, as any reordering by heuristic tends to make
  // things worse when elements are near edges or adjacent to other elements.
  const candidates: Array<{ cx: number; cy: number }> = [
    // Outside top-right
    { cx: rx + rw - cr * 0.3, cy: ry - cr * 0.7 },
    // Outside top-left
    { cx: rx + cr * 0.3,       cy: ry - cr * 0.7 },
    // Outside bottom-right
    { cx: rx + rw - cr * 0.3, cy: ry + rh + cr * 0.7 },
    // Outside bottom-left
    { cx: rx + cr * 0.3,       cy: ry + rh + cr * 0.7 },
    // Inside top-right (last resort — only if no outside position is clear)
    { cx: rx + rw - cr - lw,   cy: ry + cr + lw },
    // Inside top-left
    { cx: rx + cr + lw,         cy: ry + cr + lw },
  ];

  // Clamp each candidate so the circle is always fully inside the canvas.
  return candidates.map(({ cx, cy }) => ({
    cx: Math.min(canvasW - cr - 2, Math.max(cr + 2, cx)),
    cy: Math.min(canvasH - cr - 2, Math.max(cr + 2, cy)),
  }));
}

function circlesOverlap(
  ax: number, ay: number,
  bx: number, by: number,
  cr: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  // Circles overlap if centres are closer than 2.2 × radius (small buffer)
  return Math.sqrt(dx * dx + dy * dy) < cr * 2.2;
}

/** Returns true if the circle centre falls inside (or within cr/3 pixels of) a box.
 *  We use a small margin rather than the full radius so that circles sitting just
 *  outside a neighbour's border are still accepted. */
function circleOverlapsBox(
  cx: number, cy: number,
  rx: number, ry: number, rw: number, rh: number,
  cr: number,
): boolean {
  const margin = cr * 0.33;
  return (
    cx >= rx - margin &&
    cx <= rx + rw + margin &&
    cy >= ry - margin &&
    cy <= ry + rh + margin
  );
}

/** Returns the closest point on a rect border to the given point. */
function nearestPointOnBox(
  px: number, py: number,
  rx: number, ry: number, rw: number, rh: number,
): { x: number; y: number } {
  const clampedX = Math.max(rx, Math.min(rx + rw, px));
  const clampedY = Math.max(ry, Math.min(ry + rh, py));
  // If point is inside, snap to the nearest edge
  if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) {
    const dLeft   = px - rx;
    const dRight  = rx + rw - px;
    const dTop    = py - ry;
    const dBottom = ry + rh - py;
    const minD    = Math.min(dLeft, dRight, dTop, dBottom);
    if (minD === dLeft)   return { x: rx,        y: py };
    if (minD === dRight)  return { x: rx + rw,   y: py };
    if (minD === dTop)    return { x: px,         y: ry };
    return                       { x: px,         y: ry + rh };
  }
  return { x: clampedX, y: clampedY };
}

function buildNumberedHighlightSvg(
  h: Highlight,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
  canvasW: number,
  canvasH: number,
  /** Pre-resolved circle centre — caller handles collision avoidance. */
  circleX: number,
  circleY: number,
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

  // Connector line: draw when the circle has been pushed away from the element box.
  // Line runs from the circle edge to the nearest point on the element border.
  const nearest = nearestPointOnBox(circleX, circleY, rx, ry, rw, rh);
  const dx = circleX - nearest.x;
  const dy = circleY - nearest.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const connectorThreshold = cr * 1.8; // only draw if circle is clearly detached
  if (dist > connectorThreshold) {
    // Start the line at the circle's edge (not centre) to avoid overlapping the number
    const angle = Math.atan2(dy, dx);
    const lineStartX = circleX - (cr + 2 * scaleX) * Math.cos(angle);
    const lineStartY = circleY - (cr + 2 * scaleX) * Math.sin(angle);
    parts.push(
      `<line x1="${lineStartX}" y1="${lineStartY}" x2="${nearest.x}" y2="${nearest.y}" ` +
      `stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw * 0.75}" stroke-linecap="round" opacity="0.85"/>`
    );
  }

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
  const canvasW = imgW;
  const canvasH = imgH;
  const offsetX = 0;
  const offsetY = 0;

  const isNumbered = highlights.some((h) => h.number != null);

  if (!isNumbered) {
    // Single-highlight path — no collision resolution needed.
    const svgParts = highlights.map((h) =>
      buildSingleHighlightSvg(h, offsetX, offsetY, scaleX, scaleY, canvasW, canvasH)
    );
    const svgOverlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${svgParts.join('')}</svg>`
    );
    return sharp(rawImageBuffer)
      .composite([{ input: svgOverlay, top: 0, left: 0 }])
      .webp({ lossless: true })
      .toBuffer();
  }

  // ── Numbered highlights: two-pass layout ──────────────────────────────────
  // Pass 1: compute each highlight's box and candidate circle positions.
  // Pass 2: greedily assign positions, sorting each highlight's candidates to
  //         prefer corners that point AWAY from the centroid of the other
  //         highlights — this naturally spreads circles toward empty space.

  const pad  = 4 * scaleX;
  const lw   = 3 * scaleX;
  const cr   = CIRCLE_RADIUS * scaleX;

  interface BoxedHighlight {
    highlight: Highlight;
    rx: number; ry: number; rw: number; rh: number;
    candidates: Array<{ cx: number; cy: number }>;
  }

  const boxed: BoxedHighlight[] = highlights.map((h) => {
    const r   = h.rect;
    const ex  = (r.x - offsetX) * scaleX;
    const ey  = (r.y - offsetY) * scaleY;
    const ew  = r.width  * scaleX;
    const eh  = r.height * scaleY;
    const rx  = Math.max(0, ex - pad);
    const ry  = Math.max(0, ey - pad);
    const rw  = Math.min(canvasW - rx, ew + pad * 2);
    const rh  = Math.min(canvasH - ry, eh + pad * 2);
    return {
      highlight: h,
      rx, ry, rw, rh,
      candidates: circlePositionCandidates(rx, ry, rw, rh, cr, lw, canvasW, canvasH),
    };
  });

  // Greedy assignment with directional bias.
  const placed: Array<{ cx: number; cy: number }> = [];

  for (let i = 0; i < boxed.length; i++) {
    const b = boxed[i];

    // Compute centroid of all OTHER highlight boxes.
    const others = boxed.filter((_, j) => j !== i);

    // Sort the outside candidates (first 4) to prefer corners pointing AWAY
    // from the centroid of the other elements. Inside candidates (last 2) always
    // stay at the end as absolute last resort.
    const outside = b.candidates.slice(0, 4);
    const inside  = b.candidates.slice(4);

    if (others.length > 0) {
      const otherCx = others.reduce((s, o) => s + o.rx + o.rw / 2, 0) / others.length;
      const otherCy = others.reduce((s, o) => s + o.ry + o.rh / 2, 0) / others.length;
      const myCx = b.rx + b.rw / 2;
      const myCy = b.ry + b.rh / 2;
      // "Away" vector: direction from cluster centroid toward this element.
      const awayX = myCx - otherCx;
      const awayY = myCy - otherCy;

      outside.sort((ca, cb) => {
        // Project candidate offset onto the away vector; prefer higher dot product.
        const dotA = (ca.cx - myCx) * awayX + (ca.cy - myCy) * awayY;
        const dotB = (cb.cx - myCx) * awayX + (cb.cy - myCy) * awayY;
        return dotB - dotA;
      });
    }

    const ordered = [...outside, ...inside];

    let chosen = ordered[0];
    for (const c of ordered) {
      const collidesCircle = placed.some((p) => circlesOverlap(c.cx, c.cy, p.cx, p.cy, cr));
      const collidesBox = boxed.some((other, j) =>
        j !== i && circleOverlapsBox(c.cx, c.cy, other.rx, other.ry, other.rw, other.rh, cr)
      );
      if (!collidesCircle && !collidesBox) {
        chosen = c;
        break;
      }
    }
    placed.push(chosen);
  }

  // Build SVG with resolved positions.
  const svgParts: string[] = boxed.map((b, i) =>
    buildNumberedHighlightSvg(
      b.highlight, offsetX, offsetY, scaleX, scaleY, canvasW, canvasH,
      placed[i].cx, placed[i].cy,
    )
  );

  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${svgParts.join('')}</svg>`
  );

  return sharp(rawImageBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .webp({ lossless: true })
    .toBuffer();
}

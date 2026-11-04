// Shows the tile shape a puzzle must be cut into: a small picture plus its
// name. The picture uses one canonical orientation; the rules text explains
// that rotations and reflections are allowed.
import { resolveShape, shapeName, tileSize } from './logic.js';

const NS = 'http://www.w3.org/2000/svg';

// Build an SVG of the shape (1 unit = 1 cell).
export function tileShapeSvg(spec) {
  const cells = resolveShape(spec);
  const rows = Math.max(...cells.map(([r]) => r)) + 1;
  const cols = Math.max(...cells.map(([, c]) => c)) + 1;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
  svg.setAttribute('class', 'tile-shape-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', shapeName(spec));
  svg.style.setProperty('--tile-cols', cols);
  svg.style.setProperty('--tile-rows', rows);
  for (const [r, c] of cells) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', c);
    rect.setAttribute('y', r);
    rect.setAttribute('width', 1);
    rect.setAttribute('height', 1);
    svg.appendChild(rect);
  }
  return svg;
}

// Fill `container` with the shape picture and its name, e.g. "L tetromino".
// The tooltip has the details.
export function renderTileInfo(container, spec) {
  container.textContent = '';
  const name = document.createElement('span');
  name.className = 'tile-info-name';
  name.textContent = shapeName(spec);
  container.append(tileShapeSvg(spec), name);
  container.title = `Cut the white cells into tiles of this shape: ${shapeName(spec)}, ${tileSize(spec)} cells. ` +
    'Rotations and reflections are allowed.';
}

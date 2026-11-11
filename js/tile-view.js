// Shows the tile shape a puzzle must be cut into: a small picture plus its
// name. The picture uses one canonical orientation; the rules text explains
// that rotations and reflections are allowed.
import { resolveShape, shapeName, tileSizes, tileSpecs, topologyOfTile } from './logic.js';

const NS = 'http://www.w3.org/2000/svg';
// the colour of the cells to be tiled: they are light in the light theme and dark in the dark one
const openCells = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'white');

// Build an SVG of the shape (1 unit = 1 cell).
// `shapeIndex` picks the shape's color (the --shape-N colors in style.css): with several allowed
// shapes each gets its own, and finished tiles on the board are filled with the same color.
export function tileShapeSvg(spec, shapeIndex = 0) {
  const cells = resolveShape(spec);
  const topo = topologyOfTile(spec);
  const polys = cells.map(([r, c]) => topo.polygon(r, c));
  const xs = polys.flat().map(p => p[0]), ys = polys.flat().map(p => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const cols = x1 - x0, rows = y1 - y0;                        // (cell units; a hex picture is not a whole number of cells)
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${x0} ${y0} ${cols} ${rows}`);
  svg.setAttribute('class', `tile-shape-svg shape-${shapeIndex}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', shapeName(spec));
  svg.style.setProperty('--tile-cols', cols);
  svg.style.setProperty('--tile-rows', rows);
  for (const poly of polys) {
    const cell = document.createElementNS(NS, 'polygon');
    cell.setAttribute('points', poly.map(([x, y]) => `${x},${y}`).join(' '));
    svg.appendChild(cell);
  }
  return svg;
}

// Fill `container` with the shape picture(s) and the name(s), e.g. "L tetromino", or
// "L tetromino + T tetromino" when several shapes are allowed. The tooltip has the details.
export function renderTileInfo(container, spec) {
  container.textContent = '';
  const specs = tileSpecs(spec);
  const pictures = document.createElement('span');
  pictures.className = 'tile-swatches';
  specs.forEach((sp, i) => pictures.append(tileShapeSvg(sp, i)));
  const name = document.createElement('span');
  name.className = 'tile-info-name';
  name.textContent = shapeName(spec);
  container.append(pictures, name);
  const cells = tileSizes(spec).join(' or ');
  container.title = specs.length === 1
    ? `Cut the ${openCells()} cells into tiles of this shape: ${shapeName(spec)}, ${cells} cells. Rotations and reflections are allowed.`
    : `Cut the ${openCells()} cells into tiles, each one of these shapes (${cells} cells): ${shapeName(spec)}. ` +
      'Any of them can be used any number of times. Rotations and reflections are allowed.';
}

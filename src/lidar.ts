import maplibregl, { type LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { PointCloudLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Feature, Polygon } from 'geojson';
import { dataUrl, ringBounds, setupPanel, setupToggles, wmts } from './common';
import './style.css';

type RenderMode = 'points' | 'mns';
type ColorMode = 'reel' | 'classe' | 'hauteur';
type Basemap = 'plan' | 'ortho';

interface PointsMeta {
  count: number;
  origin: [number, number];
  zref: number;
  offset: [number, number, number];
  scale: [number, number, number];
  groups: { id: string; name: string; start: number; count: number }[];
  source: { acquisition: string };
}

interface MnsMeta {
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
}

const CLASS_COLORS: Record<number, [number, number, number]> = {
  1: [190, 190, 190],
  2: [196, 160, 112],
  3: [176, 220, 120],
  4: [104, 180, 72],
  5: [34, 120, 48],
  6: [214, 76, 64],
  9: [64, 140, 220],
  17: [150, 110, 200],
  64: [240, 180, 60],
  67: [230, 130, 110],
};
const CLASS_LABELS: Record<number, string> = {
  2: 'Sol',
  3: 'Végétation basse',
  4: 'Végétation moyenne',
  5: 'Végétation haute',
  6: 'Bâtiment',
  9: 'Eau',
  17: 'Pont',
  64: 'Sursol pérenne',
  1: 'Non classé',
};
const HEIGHT_RAMP: [number, [number, number, number]][] = [
  [0, [48, 18, 59]],
  [4, [70, 107, 227]],
  [8, [40, 187, 236]],
  [12, [100, 253, 106]],
  [16, [237, 208, 58]],
  [20, [251, 128, 34]],
  [26, [180, 20, 10]],
];
const VIEW_DURATION = 2500;

// --- Chargement des données ---

const loading = document.getElementById('loading')!;
const progressBar = document.getElementById('progress-bar')!;
const progressLabel = document.getElementById('progress-label')!;

async function fetchWithProgress(url: string, expected: number): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} : ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || expected;
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, received);
    received += value.length;
    const pct = Math.min(100, Math.round((received / total) * 100));
    progressBar.style.width = `${pct}%`;
    progressLabel.textContent = `${pct} % – ${(received / 1e6).toFixed(1)} Mo`;
  }
  return out.buffer.slice(0, received);
}

const [zone, meta, mnsMeta] = await Promise.all([
  fetch(dataUrl('zone.geojson')).then((r) => r.json() as Promise<Feature<Polygon>>),
  fetch(dataUrl('lidar/points.json')).then((r) => r.json() as Promise<PointsMeta>),
  fetch(dataUrl('lidar/mns.json')).then((r) => r.json() as Promise<MnsMeta>),
]);

const buffer = await fetchWithProgress(dataUrl('lidar/points.bin'), meta.count * 10);
loading.classList.add('done');

const n = meta.count;
const quantized = new Uint16Array(buffer, 0, n * 3);
const rgb = new Uint8Array(buffer, n * 6, n * 3);
const classes = new Uint8Array(buffer, n * 9, n);

const positions = new Float32Array(n * 3);
for (let i = 0; i < n * 3; i += 3) {
  positions[i] = meta.offset[0] + quantized[i] * meta.scale[0];
  positions[i + 1] = meta.offset[1] + quantized[i + 1] * meta.scale[1];
  positions[i + 2] = meta.offset[2] + quantized[i + 2] * meta.scale[2];
}

function heightColor(h: number): [number, number, number] {
  if (h <= HEIGHT_RAMP[0][0]) return HEIGHT_RAMP[0][1];
  for (let i = 1; i < HEIGHT_RAMP.length; i++) {
    const [h1, c1] = HEIGHT_RAMP[i];
    if (h <= h1) {
      const [h0, c0] = HEIGHT_RAMP[i - 1];
      const t = (h - h0) / (h1 - h0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return HEIGHT_RAMP[HEIGHT_RAMP.length - 1][1];
}

const colorBuffers: Partial<Record<ColorMode, Uint8Array>> = { reel: rgb };

function colorsFor(mode: ColorMode): Uint8Array {
  const cached = colorBuffers[mode];
  if (cached) return cached;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = mode === 'classe' ? (CLASS_COLORS[classes[i]] ?? CLASS_COLORS[1]) : heightColor(positions[i * 3 + 2]);
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  colorBuffers[mode] = out;
  return out;
}

// --- Carte ---

const zoneRing = zone.geometry.coordinates[0];
const [minX, minY, maxX, maxY] = ringBounds(zoneRing);
const zoneBounds: LngLatBoundsLike = [
  [minX, minY],
  [maxX, maxY],
];
const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
const mnsTiles = `${new URL(dataUrl('lidar/mns/'), location.href).href}{z}/{x}/{y}.png`;

const state: {
  render: RenderMode;
  color: ColorMode;
  basemap: Basemap;
  pointSize: number;
  visibleGroups: Set<string>;
} = {
  render: 'points',
  color: 'reel',
  basemap: 'ortho',
  pointSize: 0.45,
  visibleGroups: new Set(meta.groups.map((g) => g.id)),
};

const map = new maplibregl.Map({
  container: 'map',
  center,
  zoom: 16.6,
  pitch: 65,
  bearing: -20,
  maxPitch: 85,
  minZoom: 14,
  canvasContextAttributes: { antialias: true },
  style: {
    version: 8,
    sources: {
      plan: {
        type: 'raster',
        tiles: [wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png')],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© IGN – Plan IGN',
      },
      ortho: {
        type: 'raster',
        tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg')],
        tileSize: 256,
        maxzoom: 20,
        attribution: '© IGN – BD ORTHO®',
      },
      mns: {
        type: 'raster-dem',
        tiles: [mnsTiles],
        encoding: 'terrarium',
        tileSize: 256,
        minzoom: mnsMeta.minzoom,
        maxzoom: mnsMeta.maxzoom,
        bounds: mnsMeta.bounds,
        attribution: '© IGN – LiDAR HD',
      },
      zone: { type: 'geojson', data: zone },
    },
    layers: [
      { id: 'plan', type: 'raster', source: 'plan', layout: { visibility: 'none' } },
      { id: 'ortho', type: 'raster', source: 'ortho' },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'mns',
        layout: { visibility: 'none' },
        paint: { 'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#1d2433' },
      },
      {
        id: 'zone-outline',
        type: 'line',
        source: 'zone',
        paint: { 'line-color': '#2f5bd3', 'line-width': 2.5, 'line-dasharray': [2, 1] },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay);

function pointLayers() {
  const colors = colorsFor(state.color);
  return meta.groups.map(
    (g) =>
      new PointCloudLayer({
        id: `lidar-${g.id}`,
        data: {
          length: g.count,
          attributes: {
            getPosition: { value: positions.subarray(g.start * 3, (g.start + g.count) * 3), size: 3 },
            getColor: { value: colors.subarray(g.start * 3, (g.start + g.count) * 3), size: 3, normalized: true },
          },
        },
        visible: state.render === 'points' && state.visibleGroups.has(g.id),
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: [meta.origin[0], meta.origin[1], 0],
        pointSize: state.pointSize,
        sizeUnits: 'meters',
        material: false,
        updateTriggers: { getColor: state.color },
      }),
  );
}

function refreshPoints() {
  overlay.setProps({ layers: pointLayers() });
}

function setRender(mode: RenderMode) {
  state.render = mode;
  map.setTerrain(mode === 'mns' ? { source: 'mns', exaggeration: 1 } : null);
  const hillshade = (document.getElementById('hillshade') as HTMLInputElement).checked;
  map.setLayoutProperty('hillshade', 'visibility', mode === 'mns' && hillshade ? 'visible' : 'none');
  document.querySelectorAll<HTMLElement>('section[data-mode]').forEach((s) => {
    s.hidden = s.dataset.mode !== mode;
  });
  refreshPoints();
}

function setBasemap(value: Basemap) {
  state.basemap = value;
  map.setLayoutProperty('plan', 'visibility', value === 'plan' ? 'visible' : 'none');
  map.setLayoutProperty('ortho', 'visibility', value === 'ortho' ? 'visible' : 'none');
}

map.on('load', refreshPoints);

// --- Points de vue ---

const views: Record<string, () => void> = {
  oiseau: () => {
    const cam = map.cameraForBounds(zoneBounds, { padding: 60, bearing: 0, pitch: 0 });
    map.flyTo({ ...cam, pitch: 0, bearing: 0, duration: VIEW_DURATION });
  },
  nord: () => map.flyTo({ center, zoom: 16.6, pitch: 65, bearing: 180, duration: VIEW_DURATION }),
  sud: () => map.flyTo({ center, zoom: 16.6, pitch: 65, bearing: 0, duration: VIEW_DURATION }),
  est: () => map.flyTo({ center, zoom: 16.6, pitch: 65, bearing: 270, duration: VIEW_DURATION }),
  ouest: () => map.flyTo({ center, zoom: 16.6, pitch: 65, bearing: 90, duration: VIEW_DURATION }),
  rasante: () =>
    map.flyTo({ center, zoom: 18.5, pitch: 82, bearing: map.getBearing() + 30, duration: VIEW_DURATION + 500 }),
};

const collapsePanelOnMobile = setupPanel();

document.querySelectorAll<HTMLButtonElement>('#views button').forEach((btn) => {
  btn.addEventListener('click', () => {
    views[btn.dataset.view!]?.();
    collapsePanelOnMobile();
  });
});

// --- Contrôles ---

setupToggles({
  render: (v) => setRender(v as RenderMode),
  basemap: (v) => setBasemap(v as Basemap),
  color: (v) => {
    state.color = v as ColorMode;
    renderLegend();
    refreshPoints();
  },
});

const groupsEl = document.getElementById('groups')!;
groupsEl.innerHTML = meta.groups
  .map(
    (g) =>
      `<label class="check"><input type="checkbox" value="${g.id}" checked /> ${g.name}<span class="count">${g.count.toLocaleString('fr-FR')}</span></label>`,
  )
  .join('');
groupsEl.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.checked) state.visibleGroups.add(input.value);
  else state.visibleGroups.delete(input.value);
  refreshPoints();
});

const sizeInput = document.getElementById('point-size') as HTMLInputElement;
const sizeLabel = document.getElementById('size-label')!;
const updateSizeLabel = () => (sizeLabel.textContent = `(${state.pointSize.toFixed(2)} m)`);
sizeInput.addEventListener('input', () => {
  state.pointSize = Number(sizeInput.value);
  updateSizeLabel();
  refreshPoints();
});
updateSizeLabel();

document.getElementById('hillshade')!.addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  map.setLayoutProperty('hillshade', 'visibility', state.render === 'mns' && on ? 'visible' : 'none');
});

// --- Légende ---

const rgbCss = (c: readonly number[]) => `rgb(${c.map(Math.round).join(',')})`;

function renderLegend() {
  const legend = document.getElementById('legend')!;
  if (state.color === 'reel') {
    legend.innerHTML = `<p class="hint">Chaque point prend la couleur de l'orthophoto IGN à sa position.</p>`;
    return;
  }
  if (state.color === 'classe') {
    const present = new Set(classes);
    legend.innerHTML = Object.entries(CLASS_LABELS)
      .filter(([c]) => present.has(Number(c)))
      .map(
        ([c, label]) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${rgbCss(CLASS_COLORS[Number(c)])}"></span>${label}</div>`,
      )
      .join('');
    return;
  }
  const max = HEIGHT_RAMP[HEIGHT_RAMP.length - 1][0];
  const stops = HEIGHT_RAMP.map(([h, c]) => `${rgbCss(c)} ${(h / max) * 100}%`).join(', ');
  legend.innerHTML = `
    <div class="legend-ramp" style="background:linear-gradient(to right, ${stops})"></div>
    <div class="legend-ramp-labels"><span>0 m</span><span>${max / 2} m</span><span>${max}+ m</span></div>
    <p class="hint">Hauteur au-dessus de ${meta.zref} m (altitude IGN69).</p>`;
}

document.getElementById('count')!.textContent = n.toLocaleString('fr-FR');
document.getElementById('acquisition')!.textContent = `relevé ${meta.source.acquisition.slice(0, 4)}`;
renderLegend();

import maplibregl, {
  type ExpressionSpecification,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';
import './style.css';

type HeightProp = 'h_gouttiere' | 'h_faitage';
type ColorMode = 'height' | 'usage';
type Basemap = 'plan' | 'ortho';

const BUILDINGS = 'batiments';
const HEIGHT_RAMP: [number, string][] = [
  [0, '#fff3c4'],
  [4, '#fdc36b'],
  [8, '#f47b3d'],
  [12, '#d7304b'],
  [16, '#7a1f6b'],
];
const USAGE_COLORS: Record<string, string> = {
  'Résidentiel': '#e8a15a',
  'Commercial et services': '#4f8fd9',
  'Industriel': '#8a6fc4',
  'Sportif': '#4fb07a',
  'Annexe': '#b9b1a3',
  'Indifférencié': '#d9d2c5',
};
const USAGE_FALLBACK = '#cccccc';

function wmts(layer: string, format: string): string {
  return (
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${format}` +
    '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}'
  );
}

function ringBounds(ring: Position[]): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

const [zone, buildings] = await Promise.all([
  fetch(`${import.meta.env.BASE_URL}data/zone.geojson`).then((r) => r.json() as Promise<Feature<Polygon>>),
  fetch(`${import.meta.env.BASE_URL}data/batiments.geojson`).then((r) => r.json() as Promise<FeatureCollection>),
]);

const zoneRing = zone.geometry.coordinates[0];
const [minX, minY, maxX, maxY] = ringBounds(zoneRing);
const zoneBounds: LngLatBoundsLike = [
  [minX, minY],
  [maxX, maxY],
];
const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];

const state: { height: HeightProp; color: ColorMode; basemap: Basemap } = {
  height: 'h_gouttiere',
  color: 'height',
  basemap: 'plan',
};

const map = new maplibregl.Map({
  container: 'map',
  center,
  zoom: 16,
  pitch: 60,
  bearing: -20,
  maxPitch: 85,
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
      zone: { type: 'geojson', data: zone },
      mask: {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-180, -85],
                [180, -85],
                [180, 85],
                [-180, 85],
                [-180, -85],
              ],
              zoneRing,
            ],
          },
        },
      },
      [BUILDINGS]: { type: 'geojson', data: buildings, attribution: '© IGN – BD TOPO®' },
    },
    layers: [
      { id: 'plan', type: 'raster', source: 'plan' },
      { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
      { id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#0b1020', 'fill-opacity': 0.35 } },
      {
        id: 'zone-outline',
        type: 'line',
        source: 'zone',
        paint: { 'line-color': '#2f5bd3', 'line-width': 2.5, 'line-dasharray': [2, 1] },
      },
      {
        id: BUILDINGS,
        type: 'fill-extrusion',
        source: BUILDINGS,
        paint: {
          'fill-extrusion-color': colorExpression(),
          'fill-extrusion-height': heightExpression(),
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

function heightExpression(): ExpressionSpecification {
  return ['get', state.height];
}

function baseColorExpression(): ExpressionSpecification {
  if (state.color === 'usage') {
    const pairs = Object.entries(USAGE_COLORS).flat();
    return ['match', ['get', 'usage_1'], ...pairs, USAGE_FALLBACK] as unknown as ExpressionSpecification;
  }
  return [
    'interpolate',
    ['linear'],
    ['get', state.height],
    ...HEIGHT_RAMP.flat(),
  ] as ExpressionSpecification;
}

function colorExpression(): ExpressionSpecification {
  return [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    '#00d1ff',
    ['boolean', ['feature-state', 'hover'], false],
    '#ffe45c',
    baseColorExpression(),
  ];
}

function refreshBuildingsPaint() {
  map.setPaintProperty(BUILDINGS, 'fill-extrusion-height', heightExpression());
  map.setPaintProperty(BUILDINGS, 'fill-extrusion-color', colorExpression());
  renderLegend();
}

// --- Points de vue ---

const views: Record<string, () => void> = {
  oiseau: () => {
    const cam = map.cameraForBounds(zoneBounds, { padding: 60, bearing: 0, pitch: 0 });
    map.flyTo({ ...cam, pitch: 0, bearing: 0, duration: 2500 });
  },
  nord: () => map.flyTo({ center, zoom: 16.4, pitch: 65, bearing: 180, duration: 2500 }),
  sud: () => map.flyTo({ center, zoom: 16.4, pitch: 65, bearing: 0, duration: 2500 }),
  est: () => map.flyTo({ center, zoom: 16.4, pitch: 65, bearing: 270, duration: 2500 }),
  ouest: () => map.flyTo({ center, zoom: 16.4, pitch: 65, bearing: 90, duration: 2500 }),
  rasante: () => map.flyTo({ center, zoom: 18, pitch: 80, bearing: map.getBearing() + 30, duration: 3000 }),
};

document.querySelectorAll<HTMLButtonElement>('#views button').forEach((btn) => {
  btn.addEventListener('click', () => {
    views[btn.dataset.view!]?.();
    if (isMobile.matches) setPanelCollapsed(true);
  });
});

// --- Menu rétractable ---

const panel = document.getElementById('panel')!;
const panelToggle = document.getElementById('panel-toggle')!;
const isMobile = window.matchMedia('(max-width: 640px)');

function setPanelCollapsed(collapsed: boolean) {
  panel.classList.toggle('collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.title = collapsed ? 'Déplier le menu' : 'Replier le menu';
}

panelToggle.addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('collapsed')));
setPanelCollapsed(isMobile.matches);

// --- Toggles ---

function setBasemap(value: Basemap) {
  state.basemap = value;
  map.setLayoutProperty('plan', 'visibility', value === 'plan' ? 'visible' : 'none');
  map.setLayoutProperty('ortho', 'visibility', value === 'ortho' ? 'visible' : 'none');
}

const toggleHandlers: Record<string, (value: string) => void> = {
  basemap: (v) => setBasemap(v as Basemap),
  height: (v) => {
    state.height = v as HeightProp;
    refreshBuildingsPaint();
  },
  color: (v) => {
    state.color = v as ColorMode;
    refreshBuildingsPaint();
  },
};

document.querySelectorAll<HTMLDivElement>('.toggle').forEach((group) => {
  const buttons = group.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((btn) =>
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      toggleHandlers[group.dataset.group!]?.(btn.dataset.value!);
    }),
  );
});

// --- Légende ---

function renderLegend() {
  const legend = document.getElementById('legend')!;
  if (state.color === 'usage') {
    const present = new Set(buildings.features.map((f) => f.properties?.usage_1));
    legend.innerHTML = Object.entries(USAGE_COLORS)
      .filter(([usage]) => present.has(usage))
      .map(
        ([usage, color]) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${color}"></span>${usage}</div>`,
      )
      .join('');
    return;
  }
  const stops = HEIGHT_RAMP.map(([, c], i) => `${c} ${(i / (HEIGHT_RAMP.length - 1)) * 100}%`).join(', ');
  const max = HEIGHT_RAMP[HEIGHT_RAMP.length - 1][0];
  legend.innerHTML = `
    <div class="legend-ramp" style="background:linear-gradient(to right, ${stops})"></div>
    <div class="legend-ramp-labels"><span>0 m</span><span>${max / 2} m</span><span>${max}+ m</span></div>`;
}

document.getElementById('count')!.textContent = String(buildings.features.length);
renderLegend();

// --- Survol et fiche bâtiment ---

let hoveredId: string | number | undefined;
let selectedId: string | number | undefined;

function setFeatureState(id: string | number | undefined, key: 'hover' | 'selected', value: boolean) {
  if (id === undefined) return;
  map.setFeatureState({ source: BUILDINGS, id }, { [key]: value });
}

map.on('mousemove', BUILDINGS, (e) => {
  const id = e.features?.[0]?.id;
  if (id === hoveredId) return;
  setFeatureState(hoveredId, 'hover', false);
  hoveredId = id;
  setFeatureState(hoveredId, 'hover', true);
  map.getCanvas().style.cursor = 'pointer';
});

map.on('mouseleave', BUILDINGS, () => {
  setFeatureState(hoveredId, 'hover', false);
  hoveredId = undefined;
  map.getCanvas().style.cursor = '';
});

const fmt = (v: unknown, unit = '') =>
  v === null || v === undefined || v === '' ? '–' : `${typeof v === 'number' ? v.toLocaleString('fr-FR') : v}${unit}`;

function popupHtml(f: MapGeoJSONFeature): string {
  const p = f.properties;
  const estimated = p.hauteur_estimee === true || p.hauteur_estimee === 'true';
  const rnb = p.identifiants_rnb
    ? String(p.identifiants_rnb)
        .split('/')
        .map((id) => `<a href="https://rnb.beta.gouv.fr/carte?q=${id}" target="_blank" rel="noopener">${id}</a>`)
        .join(', ')
    : '–';
  const rows: [string, string][] = [
    [
      'Hauteur gouttière',
      estimated ? `<span class="estimated">${fmt(p.h_gouttiere, ' m')} (estimée)</span>` : fmt(p.h_gouttiere, ' m'),
    ],
    ['Hauteur faîtage', fmt(p.h_faitage, ' m')],
    ['Étages', fmt(p.nombre_d_etages)],
    ['Logements', fmt(p.nombre_de_logements)],
    ['Usage', fmt(p.usage_1) + (p.usage_2 && p.usage_2 !== 'null' ? ` / ${p.usage_2}` : '')],
    ['Nature', fmt(p.nature)],
    ['Altitude au sol', fmt(p.altitude_minimale_sol, ' m')],
    ['RNB', rnb],
  ];
  return `<div class="building-popup"><h3>Bâtiment ${fmt(p.usage_1).toLowerCase()}</h3><table>${rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join('')}</table></div>`;
}

const popup = new maplibregl.Popup({ maxWidth: '300px' });
popup.on('close', () => {
  setFeatureState(selectedId, 'selected', false);
  selectedId = undefined;
});

map.on('click', BUILDINGS, (e) => {
  const f = e.features?.[0];
  if (!f) return;
  popup.remove();
  selectedId = f.id;
  setFeatureState(selectedId, 'selected', true);
  popup.setLngLat(e.lngLat).setHTML(popupHtml(f)).addTo(map);
});

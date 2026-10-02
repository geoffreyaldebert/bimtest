import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Position } from 'geojson';

export function wmts(layer: string, format: string): string {
  return (
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${format}` +
    '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}'
  );
}

export function ringBounds(ring: Position[]): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export const dataUrl = (path: string) => `${import.meta.env.BASE_URL}data/${path}`;

// --- Configuration dans l'URL ---

const params = new URLSearchParams(location.search);

/** Valeur d'un paramètre d'URL si elle fait partie des valeurs autorisées, sinon la valeur par défaut. */
export function urlChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function urlNumber(key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const value = Number(params.get(key));
  return params.has(key) && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function urlBoolean(key: string, fallback: boolean): boolean {
  const value = params.get(key);
  return value === 'true' ? true : value === 'false' ? false : fallback;
}

export function urlList(key: string, allowed: readonly string[], fallback: string[]): Set<string> {
  if (!params.has(key)) return new Set(fallback);
  return new Set(params.get(key)!.split(',').filter((v) => allowed.includes(v)));
}

export function setUrlParams(changes: Record<string, string | number | boolean>): void {
  for (const [key, value] of Object.entries(changes)) params.set(key, String(value));
  history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
}

export interface Camera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export function urlCamera(defaults: Camera): Camera {
  return {
    center: [urlNumber('lon', defaults.center[0], -180, 180), urlNumber('lat', defaults.center[1], -85, 85)],
    zoom: urlNumber('zoom', defaults.zoom, 0, 22),
    pitch: urlNumber('pitch', defaults.pitch, 0, 85),
    bearing: urlNumber('bearing', defaults.bearing, -180, 180),
  };
}

/** Recopie la position de la caméra dans l'URL à chaque fin de déplacement. */
export function syncCameraToUrl(map: MaplibreMap): void {
  map.on('moveend', () => {
    const c = map.getCenter();
    setUrlParams({
      lon: c.lng.toFixed(6),
      lat: c.lat.toFixed(6),
      zoom: map.getZoom().toFixed(2),
      pitch: map.getPitch().toFixed(1),
      bearing: map.getBearing().toFixed(1),
    });
  });
}

const SHARED_PARAMS = ['lon', 'lat', 'zoom', 'pitch', 'bearing', 'basemap', 'panel'];

/** Le lien vers l'autre version reprend la caméra, le fond et l'état du menu. */
export function setupVersionLink(): void {
  document.querySelectorAll<HTMLAnchorElement>('.switch-version a').forEach((link) => {
    link.addEventListener('click', () => {
      const url = new URL(link.href);
      for (const key of SHARED_PARAMS) {
        if (params.has(key)) url.searchParams.set(key, params.get(key)!);
      }
      link.href = url.toString();
    });
  });
}

// --- Menu ---

const isMobile = window.matchMedia('(max-width: 640px)');

/**
 * Menu rétractable : `panel=true|false` dans l'URL force son état, sinon il est replié par défaut sur mobile.
 * Renvoie une fonction qui le replie sur mobile.
 */
export function setupPanel(): () => void {
  const panel = document.getElementById('panel')!;
  const toggle = document.getElementById('panel-toggle')!;

  const setCollapsed = (collapsed: boolean, updateUrl = true) => {
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Déplier le menu' : 'Replier le menu';
    if (updateUrl) setUrlParams({ panel: !collapsed });
  };

  toggle.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  setCollapsed(!urlBoolean('panel', !isMobile.matches), false);
  return () => {
    if (isMobile.matches) setCollapsed(true);
  };
}

/**
 * Groupes de boutons exclusifs `.toggle[data-group]`, chaque bouton portant un `data-value`.
 * Le nom du groupe sert de paramètre d'URL ; `initial` donne la valeur active au chargement.
 */
export function setupToggles(
  handlers: Record<string, (value: string) => void>,
  initial: Record<string, string>,
): void {
  document.querySelectorAll<HTMLDivElement>('.toggle').forEach((group) => {
    const name = group.dataset.group!;
    const buttons = group.querySelectorAll<HTMLButtonElement>('button');
    buttons.forEach((btn) => {
      if (name in initial) btn.classList.toggle('active', btn.dataset.value === initial[name]);
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.toggle('active', b === btn));
        setUrlParams({ [name]: btn.dataset.value! });
        handlers[name]?.(btn.dataset.value!);
      });
    });
  });
}

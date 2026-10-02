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

const isMobile = window.matchMedia('(max-width: 640px)');

/** Menu rétractable, replié par défaut sur mobile. Renvoie une fonction qui le replie sur mobile. */
export function setupPanel(): () => void {
  const panel = document.getElementById('panel')!;
  const toggle = document.getElementById('panel-toggle')!;

  const setCollapsed = (collapsed: boolean) => {
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Déplier le menu' : 'Replier le menu';
  };

  toggle.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  setCollapsed(isMobile.matches);
  return () => {
    if (isMobile.matches) setCollapsed(true);
  };
}

/** Groupes de boutons exclusifs `.toggle[data-group]`, chaque bouton portant un `data-value`. */
export function setupToggles(handlers: Record<string, (value: string) => void>): void {
  document.querySelectorAll<HTMLDivElement>('.toggle').forEach((group) => {
    const buttons = group.querySelectorAll<HTMLButtonElement>('button');
    buttons.forEach((btn) =>
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.toggle('active', b === btn));
        handlers[group.dataset.group!]?.(btn.dataset.value!);
      }),
    );
  });
}

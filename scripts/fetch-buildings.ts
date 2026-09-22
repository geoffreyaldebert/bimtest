import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import bbox from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/data');
const WFS_URL = 'https://data.geopf.fr/wfs/ows';
const DEFAULT_FLOOR_HEIGHT = 3;

const zone = JSON.parse(readFileSync(resolve(ROOT, 'douvaine.json'), 'utf8')) as Feature<Polygon>;
const [minX, minY, maxX, maxY] = bbox(zone);

const params = new URLSearchParams({
  SERVICE: 'WFS',
  VERSION: '2.0.0',
  REQUEST: 'GetFeature',
  TYPENAMES: 'BDTOPO_V3:batiment',
  outputFormat: 'application/json',
  srsName: 'EPSG:4326',
  BBOX: `${minX},${minY},${maxX},${maxY},urn:ogc:def:crs:OGC:1.3:CRS84`,
  COUNT: '5000',
});

const res = await fetch(`${WFS_URL}?${params}`);
if (!res.ok) throw new Error(`WFS ${res.status}: ${await res.text()}`);
const raw = (await res.json()) as FeatureCollection;

function strip2D(coords: unknown): unknown {
  if (typeof (coords as Position)[0] === 'number') return (coords as Position).slice(0, 2);
  return (coords as unknown[]).map(strip2D);
}

const round = (v: number) => Math.round(v * 10) / 10;

const features: Feature[] = raw.features
  .filter((f) => booleanIntersects(f, zone))
  .map((f, i) => {
    const p = f.properties ?? {};
    const etages = typeof p.nombre_d_etages === 'number' ? p.nombre_d_etages : null;
    const hauteurEstimee = typeof p.hauteur !== 'number';
    const hGouttiere = !hauteurEstimee
      ? p.hauteur
      : etages
        ? etages * DEFAULT_FLOOR_HEIGHT
        : DEFAULT_FLOOR_HEIGHT;
    const roof =
      typeof p.altitude_maximale_toit === 'number' && typeof p.altitude_minimale_sol === 'number'
        ? p.altitude_maximale_toit - p.altitude_minimale_sol
        : hGouttiere;
    const geometry = { ...f.geometry, coordinates: strip2D((f.geometry as any).coordinates) } as Geometry;
    return {
      type: 'Feature',
      id: i + 1,
      geometry,
      properties: {
        cleabs: p.cleabs,
        nature: p.nature,
        usage_1: p.usage_1 ?? 'Indifférencié',
        usage_2: p.usage_2,
        nombre_d_etages: etages,
        nombre_de_logements: p.nombre_de_logements,
        altitude_minimale_sol: p.altitude_minimale_sol,
        altitude_maximale_toit: p.altitude_maximale_toit,
        hauteur: p.hauteur,
        hauteur_estimee: hauteurEstimee,
        h_gouttiere: round(hGouttiere),
        h_faitage: round(Math.max(hGouttiere, roof)),
        identifiants_rnb: p.identifiants_rnb || null,
        date_d_apparition: p.date_d_apparition,
      },
    } satisfies Feature;
  });

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  resolve(OUT_DIR, 'batiments.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features }),
);
writeFileSync(resolve(OUT_DIR, 'zone.geojson'), JSON.stringify(zone));

const estimated = features.filter((f) => f.properties!.hauteur_estimee).length;
console.log(`${raw.features.length} bâtiments dans la bbox, ${features.length} dans la zone (${estimated} hauteurs estimées).`);

# Douvaine en 3D

Visualisation 3D des bâtiments d'un quartier de Douvaine (Haute-Savoie), à partir de leur hauteur réelle issue de la **BD TOPO® de l'IGN**. L'appli est construite avec [MapLibre GL JS](https://maplibre.org/) (couche `fill-extrusion`), Vite et TypeScript.

Fonctionnalités :

- six points de vue inclinés avec transition animée : vue d'oiseau, depuis le Nord, le Sud, l'Est, l'Ouest, et une vue rasante au niveau de la rue ;
- fond Plan IGN ou orthophoto IGN ;
- hauteur à la gouttière ou au faîtage ;
- couleurs par hauteur ou par usage ;
- fiche bâtiment au clic : hauteurs, étages, logements, usage, altitude, lien vers le RNB ;
- menu rétractable, replié par défaut sur mobile.

## Lancer le projet

Il faut Node.js 20 ou plus récent.

```bash
npm install
npm run dev          # serveur de développement sur http://localhost:5173
npm run build        # build de production dans dist/
npm run fetch-data   # régénère les données bâtiments (voir plus bas)
```

## Déploiement

Le workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml) construit l'appli et la publie sur GitHub Pages à chaque push sur `main`. Il faut d'abord régler, dans les paramètres du dépôt, **Settings > Pages > Source** sur **GitHub Actions**.

Vite est configuré avec `base: './'`, donc l'appli fonctionne quel que soit le nom du dépôt.

## Données

### Zone d'étude

[douvaine.json](douvaine.json) contient un polygone GeoJSON (EPSG:4326) dessiné à la main. Il délimite le quartier étudié.

### Bâtiments : BD TOPO® (IGN)

Les bâtiments viennent de la couche `BDTOPO_V3:batiment`, publiée par le service **WFS de la Géoplateforme IGN**. Ce service est public et ne demande pas de clé.

La seule requête exécutée pour constituer le jeu de données est la suivante. L'emprise (bbox) est calculée à partir du polygone de la zone :

```
https://data.geopf.fr/wfs/ows
  ?SERVICE=WFS
  &VERSION=2.0.0
  &REQUEST=GetFeature
  &TYPENAMES=BDTOPO_V3:batiment
  &outputFormat=application/json
  &srsName=EPSG:4326
  &BBOX=6.3021605,46.296483,6.3116623,46.3052358,urn:ogc:def:crs:OGC:1.3:CRS84
  &COUNT=5000
```

Équivalent avec `curl` :

```bash
curl -s "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&outputFormat=application/json&srsName=EPSG:4326&BBOX=6.3021605,46.296483,6.3116623,46.3052358,urn:ogc:def:crs:OGC:1.3:CRS84&COUNT=5000" -o batiments_bbox.geojson
```

L'emprise doit être exprimée en `CRS84`, c'est-à-dire dans l'ordre longitude puis latitude. Si on passe la bbox en `EPSG:4326`, le WFS l'interprète dans l'ordre latitude puis longitude et ne renvoie aucun objet.

Le script [scripts/fetch-buildings.ts](scripts/fetch-buildings.ts) (`npm run fetch-data`) exécute cette requête, puis traite le résultat :

1. **Découpage** : il ne garde que les bâtiments qui intersectent le polygone de la zone (`@turf/boolean-intersects`). La bbox contenait 337 bâtiments, et 169 sont retenus dans la zone.
2. **Passage en 2D** : il retire l'altitude Z des coordonnées, car MapLibre extrude à partir du sol.
3. **Calcul des hauteurs** :
   - `h_gouttiere` reprend le champ `hauteur` de la BD TOPO, qui mesure la hauteur du sol à la gouttière. Si ce champ est vide, on estime `nombre_d_etages × 3 m`, et à défaut 3 m. Le booléen `hauteur_estimee` signale ces cas ; il y en a 3 sur 169.
   - `h_faitage` = `altitude_maximale_toit − altitude_minimale_sol`, avec `h_gouttiere` comme minimum.
4. **Attributs conservés** : `cleabs`, `nature`, `usage_1`, `usage_2`, `nombre_d_etages`, `nombre_de_logements`, `altitude_minimale_sol`, `altitude_maximale_toit`, `hauteur`, `identifiants_rnb`, `date_d_apparition`.
5. **Écriture** : les résultats vont dans [public/data/batiments.geojson](public/data/batiments.geojson) et [public/data/zone.geojson](public/data/zone.geojson), qui est une copie de `douvaine.json`.

Ces fichiers sont versionnés. L'appli ne rappelle donc pas le WFS au chargement, et le build GitHub Pages ne dépend pas du service de l'IGN. Pour mettre les données à jour, ou après avoir modifié `douvaine.json`, relance `npm run fetch-data`.

Pour explorer ces données en ligne : [BD TOPO Explorer – bâtiment](https://bdtopoexplorer.ign.fr/batiment).

### Fonds de carte : WMTS IGN

Les fonds de carte sont des tuiles raster chargées directement depuis le WMTS de la Géoplateforme, sans clé :

- Plan IGN : `GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2` (png)
- Orthophotographie : `ORTHOIMAGERY.ORTHOPHOTOS` (jpeg)

```
https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=<couche>&STYLE=normal&TILEMATRIXSET=PM&FORMAT=<format>&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}
```

### Liens RNB

La fiche d'un bâtiment renvoie vers le [Référentiel National des Bâtiments](https://rnb.beta.gouv.fr/) grâce au champ `identifiants_rnb` de la BD TOPO.

## Limites

- Le relief n'est pas modélisé : tous les bâtiments sont extrudés depuis un sol plat. Le quartier étant peu pentu, le rendu reste réaliste.
- Les toits sont plats. Le mode « faîtage » donne la hauteur maximale, mais pas la forme du toit.

## Ressources

- [MapLibre : extrusion de polygones pour une carte 3D d'intérieur](https://maplibre.org/maplibre-gl-js/docs/examples/extrude-polygons-for-3d-indoor-mapping/)
- [MapLibre : globe avec couche fill-extrusion](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-fill-extrusion-layer/)
- [Extrusion de bâtiments 3D avec MapLibre (fwdtools)](https://fwdtools.com/ui-snippets/maplibre-3d-building-extrusion/)

## Licence des données

BD TOPO®, Plan IGN et BD ORTHO® © IGN, diffusés sous [Licence Ouverte Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).

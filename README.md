# Douvaine en 3D

Visualisation 3D d'un quartier de Douvaine (Haute-Savoie) à partir des données de l'IGN, en deux versions :

- [index.html](index.html) : **version BD TOPO**, avec les bâtiments en volumes extrudés à leur hauteur réelle ([MapLibre GL JS](https://maplibre.org/), couche `fill-extrusion`) ;
- [lidar.html](lidar.html) : **version LiDAR HD**, avec le nuage de points 3D (bâtiments détaillés, arbres, haies) ou la surface du MNS LiDAR, rendue par [deck.gl](https://deck.gl/) au-dessus de MapLibre.

Les deux pages sont reliées par un lien dans leur menu. Elles sont construites avec Vite et TypeScript.

Fonctionnalités de la version BD TOPO :

- six points de vue inclinés avec transition animée : vue d'oiseau, depuis le Nord, le Sud, l'Est, l'Ouest, et une vue rasante au niveau de la rue ;
- fond Plan IGN ou orthophoto IGN ;
- hauteur à la gouttière ou au faîtage ;
- couleurs par hauteur ou par usage ;
- fiche bâtiment au clic : hauteurs, étages, logements, usage, altitude, lien vers le RNB ;
- menu rétractable, replié par défaut sur mobile.

Fonctionnalités de la version LiDAR :

- deux rendus :
  - **nuage de points** : 3 millions de points LiDAR HD ;
  - **surface MNS** : modèle numérique de surface à 50 cm, avec le fond de carte drapé dessus et un ombrage optionnel ;
- couleurs des points :
  - réelles, prises sur l'orthophoto ;
  - par classe LiDAR ;
  - par hauteur ;
- affichage ou masquage par groupe de classes : sol, végétation, bâti, autres ;
- taille des points réglable, en mètres ;
- densité **standard**, avec 3 millions de points (30 Mo), ou **complète**, avec les 5,8 millions de points de la zone (58 Mo). La densité complète n'est chargée que si on la choisit ;
- mêmes points de vue, fonds de carte et menu rétractable que la version BD TOPO.

## Configuration par l'URL

Chaque réglage de l'interface est recopié dans l'URL au fil des clics, ainsi que la position de la caméra. Une URL copiée rouvre donc la page exactement dans la même configuration. On peut aussi écrire ces URL à la main. Un paramètre absent ou invalide prend sa valeur par défaut.

Le lien qui mène d'une version à l'autre reprend la caméra, le fond de carte et l'état du menu.

Paramètres communs aux deux pages :

| Paramètre | Valeurs | Défaut |
| --- | --- | --- |
| `panel` | `true` (menu ouvert), `false` (menu replié) | ouvert, sauf sur mobile |
| `basemap` | `plan`, `ortho` | `plan` (BD TOPO), `ortho` (LiDAR) |
| `lon`, `lat` | centre de la vue, en degrés WGS84 | centre de la zone |
| `zoom` | niveau de zoom | 16 (BD TOPO), 16,6 (LiDAR) |
| `pitch` | inclinaison, de 0 à 85° | 60 (BD TOPO), 65 (LiDAR) |
| `bearing` | orientation, de -180 à 180° | -20 |

Version BD TOPO ([index.html](index.html)) :

| Paramètre | Valeurs | Défaut |
| --- | --- | --- |
| `height` | `h_gouttiere`, `h_faitage` | `h_gouttiere` |
| `color` | `height`, `usage` | `height` |

Version LiDAR ([lidar.html](lidar.html)) :

| Paramètre | Valeurs | Défaut |
| --- | --- | --- |
| `render` | `points`, `mns` | `points` |
| `density` | `standard`, `hd` | `standard` |
| `color` | `reel`, `classe`, `hauteur` | `reel` |
| `classes` | liste séparée par des virgules parmi `sol`, `vegetation`, `bati`, `autres` | toutes |
| `size` | taille des points, de 0,1 à 1,2 m | `0.45` |
| `hillshade` | `true`, `false` | `false` |

Exemples :

- Végétation et bâti seulement, en couleurs par classe et en densité complète, menu replié :
  `lidar.html?density=hd&color=classe&classes=vegetation,bati&size=0.3&panel=false&lon=6.3075&lat=46.3005&zoom=17.8&pitch=70&bearing=40`
- Surface MNS ombrée sur le Plan IGN :
  `lidar.html?render=mns&hillshade=true&basemap=plan&lon=6.3075&lat=46.3005&zoom=17.5&pitch=70&bearing=-30`
- Bâtiments BD TOPO à la hauteur du faîtage, colorés par usage, sur l'orthophoto :
  `?basemap=ortho&height=h_faitage&color=usage&panel=false&zoom=17.5&pitch=70&bearing=120`

## Lancer le projet

Il faut Node.js 20 ou plus récent, et Python 3.10 ou plus récent seulement pour régénérer les données LiDAR.

```bash
npm install
npm run dev          # serveur de développement sur http://localhost:5173 (et /lidar.html)
npm run build        # build de production dans dist/
npm run fetch-data   # régénère les données bâtiments BD TOPO (voir plus bas)

# régénère les données LiDAR (voir plus bas)
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/fetch_lidar.py            # option : --points 1000000 (densité standard)
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

### Nuage de points et MNS : LiDAR HD (IGN)

Le script [scripts/fetch_lidar.py](scripts/fetch_lidar.py) constitue les données de la version LiDAR. Il enchaîne les requêtes suivantes, toutes sur des services publics de la Géoplateforme IGN, sans clé.

**1. Trouver les dalles LiDAR qui couvrent la zone**, avec le WFS des métadonnées LiDAR HD :

```
https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature
  &TYPENAMES=IGNF_LIDAR-HD_METADONNEE:metadata&outputFormat=application/json&srsName=EPSG:4326
  &BBOX=6.3021605,46.296483,6.3116623,46.3052358,urn:ogc:def:crs:OGC:1.3:CRS84
```

Deux dalles de 1 km × 1 km couvrent la zone. Elles ont été acquises du 10 juillet au 5 septembre 2021 et classées automatiquement par l'IGN (procédé `IGN_AUTO_V5`). Le champ `url_npl` de chaque dalle donne son lien de téléchargement.

**2. Télécharger les nuages de points** au format COPC LAZ, environ 75 Mo et 15 millions de points par dalle :

```
https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_QK_2025-06-13/LHD_FXX_0954_6583_PTS_LAMB93_IGN69.copc.laz
https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_QK_2025-06-13/LHD_FXX_0954_6584_PTS_LAMB93_IGN69.copc.laz
```

Deux particularités de ce serveur :
- il répond 403 à l'User-Agent par défaut de Python, donc le script envoie le sien ;
- il coupe souvent les transferts longs, donc le script reprend le téléchargement là où il s'était arrêté (en-tête `Range`).

Les fichiers sont mis en cache dans `.cache/lidar/`, qui n'est pas versionné.

**3. Traitement du nuage :**

1. **Découpage** sur le polygone de la zone, reprojeté en Lambert-93 : 5 767 279 points retenus sur les 30,3 millions des deux dalles.
2. **Classes retirées** : 7 (bruit), 65 (artefacts) et 66 (points virtuels).
3. **Altitude de référence** : 430 m IGN69, soit le 1er centile de l'altitude des points de sol, arrondi à l'unité inférieure. Toutes les hauteurs sont données au-dessus de cette altitude.
4. **Deux densités** :
   - **standard** : décimation aléatoire à environ 3 millions de points (3 001 209). Les points de sol, très nombreux et peu informatifs, sont gardés deux fois moins que les autres ;
   - **complète** : les 5 767 279 points de la zone, sans décimation.
5. **Reprojection en WGS84**, puis conversion en décalages en mètres autour du centre de la zone : c'est le format `METER_OFFSETS` attendu par deck.gl.
6. **Colorisation** : les dalles LiDAR HD ne contiennent pas de couleurs. Chaque point prend donc la couleur du pixel de l'orthophoto IGN à sa position, récupérée par le WMS-R en EPSG:3857 au niveau de zoom 19 (environ 0,2 m par pixel), en 30 blocs de 1024 × 1024 px :

   ```
   https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS
     &STYLES=&FORMAT=image/jpeg&CRS=EPSG:3857&BBOX=<xmin,ymin,xmax,ymax>&WIDTH=1024&HEIGHT=1024
   ```

7. **Écriture** de [public/data/lidar/points.bin](public/data/lidar/points.bin) (densité standard, 30 Mo) et de `public/data/lidar/points-hd.bin` (densité complète, 58 Mo), à 10 octets par point :
   - les positions, quantifiées sur 3 × `uint16` ;
   - la couleur, sur 3 × `uint8` ;
   - la classe, sur 1 × `uint8`.

   Les points sont triés par groupe : sol et eau, végétation, bâti, autres. Chaque `.bin` a son `.json`, par exemple [points.json](public/data/lidar/points.json), qui décrit l'origine, l'échelle de quantification et la position de chaque groupe dans le fichier.

**4. MNS LiDAR HD**, demandé au WMS-R en GeoTIFF float32 et directement en EPSG:3857, par blocs de 1024 × 1024 px alignés sur la grille des tuiles web (16 blocs) :

```
https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap
  &LAYERS=IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93
  &STYLES=&FORMAT=image/geotiff&CRS=EPSG:3857&BBOX=<xmin,ymin,xmax,ymax>&WIDTH=1024&HEIGHT=1024
```

L'altitude de référence de 430 m est soustraite du MNS. Celui-ci est ensuite découpé en 340 tuiles PNG 256 px, encodées au format [terrarium](https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium), du zoom 15 au zoom 18 (environ 0,4 m par pixel au zoom 18). Elles sont écrites dans `public/data/lidar/mns/{z}/{x}/{y}.png`, que MapLibre lit comme source `raster-dem` pour le relief. Le fichier [mns.json](public/data/lidar/mns.json) donne l'emprise et les niveaux de zoom.

Comme le nuage et le MNS partagent la même altitude de référence, les deux rendus sont cohérents. Toutes ces données sont versionnées, donc le build GitHub Pages n'a besoin ni de Python ni des services IGN.

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
- **Version LiDAR, couleurs** : elles viennent d'une orthophoto vue du dessus. Les façades prennent donc la couleur du toit ou du sol voisin, et la date de l'orthophoto diffère de celle du relevé LiDAR (2021).
- **Version LiDAR, poids** : environ 30 Mo de points à télécharger au premier chargement.
- **Version LiDAR, surface MNS** : c'est une surface continue. Les arbres et les murs y apparaissent comme des pentes raides plutôt que comme des volumes distincts.

## Ressources

- [MapLibre : extrusion de polygones pour une carte 3D d'intérieur](https://maplibre.org/maplibre-gl-js/docs/examples/extrude-polygons-for-3d-indoor-mapping/)
- [MapLibre : globe avec couche fill-extrusion](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-fill-extrusion-layer/)
- [Extrusion de bâtiments 3D avec MapLibre (fwdtools)](https://fwdtools.com/ui-snippets/maplibre-3d-building-extrusion/)

## Licence des données

BD TOPO®, LiDAR HD, Plan IGN et BD ORTHO® © IGN, diffusés sous [Licence Ouverte Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).

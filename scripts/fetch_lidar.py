"""Prépare les données LiDAR HD (IGN) de la zone pour la page lidar.html.

Produit dans public/data/lidar/ :
- points.bin / points.json : nuage de points découpé sur la zone, décimé,
  coloré à partir de l'orthophoto IGN et trié par groupe de classes ;
- mns/{z}/{x}/{y}.png / mns.json : tuiles d'élévation (encodage terrarium)
  issues du MNS LiDAR HD à 50 cm, relatives à la même altitude de référence.

Usage : .venv/bin/python scripts/fetch_lidar.py [--points 3000000]
"""

from __future__ import annotations

import argparse
import io
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import laspy
import numpy as np
import shapely
import tifffile
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "lidar"
OUT = ROOT / "public" / "data" / "lidar"

WFS = "https://data.geopf.fr/wfs/ows"
WMS_R = "https://data.geopf.fr/wms-r"
MNS_LAYER = "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93"
ORTHO_LAYER = "ORTHOIMAGERY.ORTHOPHOTOS"

EARTH_RADIUS = 6378137.0
MERC_HALF = math.pi * EARTH_RADIUS
TILE_SIZE = 256
BLOCK_TILES = 4  # une requête WMS = 4 x 4 tuiles = 1024 px
MNS_MIN_ZOOM = 15
MNS_MAX_ZOOM = 18
ORTHO_ZOOM = 19
MARGIN_M = 120

# Classes LiDAR HD : 1 non classé, 2 sol, 3/4/5 végétation basse/moyenne/haute,
# 6 bâtiment, 9 eau, 17 pont, 64 sursol pérenne, 65 artefact, 66 points virtuels, 67 divers bâti.
EXCLUDED_CLASSES = {7, 65, 66}
GROUPS = [
    {"id": "sol", "name": "Sol et eau", "classes": [2, 9]},
    {"id": "vegetation", "name": "Végétation", "classes": [3, 4, 5]},
    {"id": "bati", "name": "Bâti", "classes": [6, 67]},
    {"id": "autres", "name": "Autres (ponts, sursol, non classé)", "classes": None},
]
GROUND_KEEP_RATIO = 0.5


def log(msg: str) -> None:
    print(msg, flush=True)


USER_AGENT = "bimdouvaine/0.1 (+https://github.com/geoffreyaldebert/bimtest)"


def request(url: str, headers: dict[str, str] | None = None, method: str = "GET") -> urllib.request.Request:
    """Le serveur de téléchargement IGN répond 403 à l'User-Agent par défaut de urllib."""
    return urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})}, method=method)


def http_get(url: str, retries: int = 4) -> bytes:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request(url), timeout=120) as r:
                return r.read()
        except Exception as exc:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            log(f"  nouvelle tentative ({exc})")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def download_resumable(url: str, dest: Path, expected: int | None) -> None:
    """Le serveur de téléchargement IGN coupe souvent les transferts longs : on reprend avec Range."""
    for _ in range(20):
        have = dest.stat().st_size if dest.exists() else 0
        if expected is not None and have == expected:
            return
        req = request(url, {"Range": f"bytes={have}-"} if have else None)
        try:
            with urllib.request.urlopen(req, timeout=300) as r, dest.open("ab" if have else "wb") as f:
                if have and r.status != 206:
                    f.truncate(0)
                while chunk := r.read(1 << 20):
                    f.write(chunk)
        except Exception as exc:  # noqa: BLE001
            log(f"  transfert interrompu ({exc}), reprise…")
        if expected is None:
            return
    raise RuntimeError(f"Téléchargement incomplet : {url}")


def content_length(url: str) -> int | None:
    with urllib.request.urlopen(request(url, method="HEAD"), timeout=60) as r:
        value = r.headers.get("Content-Length")
    return int(value) if value else None


# --- Géométrie ---------------------------------------------------------------


def lonlat_to_merc(lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x = np.radians(lon) * EARTH_RADIUS
    y = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * EARTH_RADIUS
    return x, y


def tile_span(z: int) -> float:
    return 2 * MERC_HALF / (1 << z)


def merc_to_tile(x: float, y: float, z: int) -> tuple[float, float]:
    span = tile_span(z)
    return (x + MERC_HALF) / span, (MERC_HALF - y) / span


def tile_bounds_merc(tx: int, ty: int, z: int) -> tuple[float, float, float, float]:
    span = tile_span(z)
    minx = tx * span - MERC_HALF
    maxy = MERC_HALF - ty * span
    return minx, maxy - span, minx + span, maxy


def tile_range(bbox_merc, z: int, align: int) -> tuple[int, int, int, int]:
    """Plage de tuiles (inclusive-exclusive) couvrant la bbox, alignée sur un multiple de `align`."""
    fx0, fy0 = merc_to_tile(bbox_merc[0], bbox_merc[3], z)
    fx1, fy1 = merc_to_tile(bbox_merc[2], bbox_merc[1], z)
    tx0 = math.floor(fx0 / align) * align
    ty0 = math.floor(fy0 / align) * align
    tx1 = math.ceil(fx1 / align) * align
    ty1 = math.ceil(fy1 / align) * align
    return tx0, ty0, tx1, ty1


def wms_block(layer: str, fmt: str, bbox_merc, width: int, height: int) -> bytes:
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": layer,
        "STYLES": "",
        "FORMAT": fmt,
        "CRS": "EPSG:3857",
        "BBOX": ",".join(f"{v:.3f}" for v in bbox_merc),
        "WIDTH": str(width),
        "HEIGHT": str(height),
    }
    return http_get(f"{WMS_R}?{urllib.parse.urlencode(params)}")


def fetch_mosaic(layer: str, fmt: str, z: int, trange, needed_bbox, cache_name: str, channels: int):
    """Mosaïque WMS alignée sur la grille de tuiles z, assemblée par blocs de 1024 px (mis en cache)."""
    tx0, ty0, tx1, ty1 = trange
    w, h = (tx1 - tx0) * TILE_SIZE, (ty1 - ty0) * TILE_SIZE
    dtype = np.float32 if channels == 1 else np.uint8
    shape_ = (h, w) if channels == 1 else (h, w, channels)
    mosaic = np.full(shape_, np.nan if channels == 1 else 0, dtype=dtype)
    block_dir = CACHE / cache_name
    block_dir.mkdir(parents=True, exist_ok=True)
    blocks = [
        (bx, by)
        for by in range(ty0, ty1, BLOCK_TILES)
        for bx in range(tx0, tx1, BLOCK_TILES)
    ]
    for i, (bx, by) in enumerate(blocks):
        minx, _, _, maxy = tile_bounds_merc(bx, by, z)
        span = tile_span(z) * BLOCK_TILES
        bb = (minx, maxy - span, minx + span, maxy)
        if bb[2] < needed_bbox[0] or bb[0] > needed_bbox[2] or bb[3] < needed_bbox[1] or bb[1] > needed_bbox[3]:
            continue
        px = BLOCK_TILES * TILE_SIZE
        cached = block_dir / f"{z}_{bx}_{by}.{'tif' if channels == 1 else 'png'}"
        if not cached.exists():
            log(f"  bloc {i + 1}/{len(blocks)} ({cache_name})")
            cached.write_bytes(wms_block(layer, fmt, bb, px, px))
        if channels == 1:
            arr = tifffile.imread(cached).astype(np.float32)
        else:
            arr = np.asarray(Image.open(cached).convert("RGB"))
        oy, ox = (by - ty0) * TILE_SIZE, (bx - tx0) * TILE_SIZE
        mosaic[oy : oy + px, ox : ox + px] = arr
    return mosaic


# --- Nuage de points ---------------------------------------------------------


def lidar_tiles(bbox_lonlat) -> list[dict]:
    params = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        "TYPENAMES": "IGNF_LIDAR-HD_METADONNEE:metadata",
        "outputFormat": "application/json",
        "srsName": "EPSG:4326",
        "BBOX": ",".join(map(str, bbox_lonlat)) + ",urn:ogc:def:crs:OGC:1.3:CRS84",
    }
    data = json.loads(http_get(f"{WFS}?{urllib.parse.urlencode(params)}"))
    return [f["properties"] for f in data["features"]]


def read_points(paths: list[Path], zone_l93) -> dict[str, np.ndarray]:
    minx, miny, maxx, maxy = zone_l93.bounds
    shapely.prepare(zone_l93)
    parts: dict[str, list[np.ndarray]] = {"x": [], "y": [], "z": [], "cls": []}
    for path in paths:
        las = laspy.read(path)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
        cls = np.asarray(las.classification, dtype=np.uint8)
        m = (x >= minx) & (x <= maxx) & (y >= miny) & (y <= maxy) & ~np.isin(cls, list(EXCLUDED_CLASSES))
        x, y, z, cls = x[m], y[m], z[m], cls[m]
        inside = shapely.contains_xy(zone_l93, x, y)
        log(f"  {path.name} : {len(las.x):,} points, {inside.sum():,} dans la zone")
        for k, v in zip(("x", "y", "z", "cls"), (x[inside], y[inside], z[inside], cls[inside])):
            parts[k].append(v)
        del las
    return {k: np.concatenate(v) for k, v in parts.items()}


def group_index(cls: np.ndarray) -> np.ndarray:
    g = np.full(cls.shape, len(GROUPS) - 1, dtype=np.uint8)
    for i, group in enumerate(GROUPS):
        if group["classes"] is not None:
            g[np.isin(cls, group["classes"])] = i
    return g


def decimate(groups: np.ndarray, target: int | None, rng: np.random.Generator) -> np.ndarray:
    if target is None or target >= len(groups):
        return np.ones(groups.shape, dtype=bool)
    is_ground = groups == 0
    n_ground, n_other = int(is_ground.sum()), int((~is_ground).sum())
    p_other = min(1.0, target / (n_other + GROUND_KEEP_RATIO * n_ground))
    p = np.where(is_ground, p_other * GROUND_KEEP_RATIO, p_other)
    return rng.random(groups.shape) < p


def build_points(zone, zone_l93, center_lonlat, densities: dict[str, int | None]) -> float:
    """Écrit un jeu `<nom>.bin` / `<nom>.json` par densité ; renvoie l'altitude de référence."""
    bbox_lonlat = zone.bounds
    tiles = lidar_tiles(bbox_lonlat)
    log(f"{len(tiles)} dalles LiDAR HD couvrent la zone")
    paths = []
    for t in tiles:
        url = t["url_npl"]
        dest = CACHE / url.rsplit("/", 1)[-1]
        log(f"  téléchargement {dest.name}")
        download_resumable(url, dest, content_length(url))
        paths.append(dest)

    pts = read_points(paths, zone_l93)
    groups = group_index(pts["cls"])
    zref = float(math.floor(np.percentile(pts["z"][groups == 0], 1)))
    log(f"{len(groups):,} points dans la zone, altitude de référence {zref} m")

    source = {
        "dalles": [t["url_npl"] for t in tiles],
        "acquisition": f"{tiles[0]['date_debut_acquisition'][:10]} / {tiles[0]['date_fin_acquisition'][:10]}",
        "classement": tiles[0]["procede_classement"],
    }
    for name, target in densities.items():
        keep = decimate(groups, target, np.random.default_rng(42))
        write_points(
            name,
            {k: v[keep] for k, v in pts.items()},
            groups[keep],
            center_lonlat,
            zref,
            source,
        )
    return zref


def write_points(name: str, pts: dict[str, np.ndarray], groups: np.ndarray, center_lonlat, zref: float, source) -> None:
    lon_c, lat_c = center_lonlat
    order = np.argsort(groups, kind="stable")
    x, y, z, cls, groups = pts["x"][order], pts["y"][order], pts["z"][order], pts["cls"][order], groups[order]
    log(f"{name} : {len(x):,} points")

    to_wgs = Transformer.from_crs(2154, 4326, always_xy=True)
    lon, lat = to_wgs.transform(x, y)

    # Offsets en mètres autour du centre, comme les attend deck.gl (COORDINATE_SYSTEM.METER_OFFSETS).
    k = math.pi / 180 * EARTH_RADIUS
    east = (lon - lon_c) * k * math.cos(math.radians(lat_c))
    north = (lat - lat_c) * k
    up = z - zref

    rgb = ortho_colors(lon, lat)

    xyz = np.stack([east, north, up], axis=1)
    offset = xyz.min(axis=0)
    scale = (xyz.max(axis=0) - offset) / 65535
    quant = np.round((xyz - offset) / scale).astype("<u2")

    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / f"{name}.bin").open("wb") as f:
        f.write(quant.tobytes())
        f.write(rgb.astype(np.uint8).tobytes())
        f.write(cls.astype(np.uint8).tobytes())

    counts = np.bincount(groups, minlength=len(GROUPS))
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    meta = {
        "count": int(len(x)),
        "origin": [lon_c, lat_c],
        "zref": zref,
        "offset": offset.tolist(),
        "scale": scale.tolist(),
        "layout": ["positions uint16 x3", "rgb uint8 x3", "classification uint8"],
        "groups": [
            {"id": g["id"], "name": g["name"], "start": int(s), "count": int(c)}
            for g, s, c in zip(GROUPS, starts, counts)
        ],
        "source": source,
    }
    (OUT / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    size = (OUT / f"{name}.bin").stat().st_size / 1e6
    log(f"{name}.bin : {size:.1f} Mo")


def ortho_colors(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    mx, my = lonlat_to_merc(lon, lat)
    bbox = (mx.min(), my.min(), mx.max(), my.max())
    trange = tile_range(bbox, ORTHO_ZOOM, BLOCK_TILES)
    log("Colorisation à partir de l'orthophoto IGN")
    mosaic = fetch_mosaic(ORTHO_LAYER, "image/jpeg", ORTHO_ZOOM, trange, bbox, "ortho", 3)
    tx0, ty0 = trange[0], trange[1]
    fx, fy = merc_to_tile(mx, my, ORTHO_ZOOM)  # type: ignore[arg-type]
    px = np.clip(((fx - tx0) * TILE_SIZE).astype(int), 0, mosaic.shape[1] - 1)
    py = np.clip(((fy - ty0) * TILE_SIZE).astype(int), 0, mosaic.shape[0] - 1)
    return mosaic[py, px]


# --- MNS -> tuiles terrarium -------------------------------------------------


def encode_terrarium(h: np.ndarray) -> np.ndarray:
    v = np.clip(h, -32768, 32767) + 32768.0
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.floor((v - np.floor(v)) * 256)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def build_mns(zone, zref: float) -> None:
    w, s, e, n = zone.bounds
    mx, my = lonlat_to_merc(np.array([w, e]), np.array([s, n]))
    pad = MARGIN_M / math.cos(math.radians((s + n) / 2))
    bbox = (mx[0] - pad, my[0] - pad, mx[1] + pad, my[1] + pad)
    align = 1 << (MNS_MAX_ZOOM - MNS_MIN_ZOOM)
    trange = tile_range(bbox, MNS_MAX_ZOOM, max(align, BLOCK_TILES))
    log("MNS LiDAR HD (WMS-R)")
    mosaic = fetch_mosaic(MNS_LAYER, "image/geotiff", MNS_MAX_ZOOM, trange, bbox, "mns", 1)
    mosaic[(mosaic < -1000) | ~np.isfinite(mosaic)] = np.nan
    rel = mosaic - zref
    rel[np.isnan(rel)] = 0.0

    tx0, ty0, tx1, ty1 = trange
    out = OUT / "mns"
    count = 0
    level = rel
    for z in range(MNS_MAX_ZOOM, MNS_MIN_ZOOM - 1, -1):
        f = 1 << (MNS_MAX_ZOOM - z)
        zx0, zy0 = tx0 // f, ty0 // f
        nx, ny = level.shape[1] // TILE_SIZE, level.shape[0] // TILE_SIZE
        for j in range(ny):
            for i in range(nx):
                tile = level[j * TILE_SIZE : (j + 1) * TILE_SIZE, i * TILE_SIZE : (i + 1) * TILE_SIZE]
                path = out / str(z) / str(zx0 + i) / f"{zy0 + j}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                buf = io.BytesIO()
                Image.fromarray(encode_terrarium(tile), "RGB").save(buf, "PNG", optimize=True)
                path.write_bytes(buf.getvalue())
                count += 1
        level = level.reshape(level.shape[0] // 2, 2, level.shape[1] // 2, 2).mean(axis=(1, 3))

    tb_w, _, _, tb_n = tile_bounds_merc(tx0, ty0, MNS_MAX_ZOOM)
    _, tb_s, tb_e, _ = tile_bounds_merc(tx1 - 1, ty1 - 1, MNS_MAX_ZOOM)
    to_wgs = Transformer.from_crs(3857, 4326, always_xy=True)
    bw, bs = to_wgs.transform(tb_w, tb_s)
    be, bn = to_wgs.transform(tb_e, tb_n)
    meta = {
        "encoding": "terrarium",
        "minzoom": MNS_MIN_ZOOM,
        "maxzoom": MNS_MAX_ZOOM,
        "bounds": [bw, bs, be, bn],
        "zref": zref,
        "source": f"{WMS_R} — {MNS_LAYER}",
    }
    (OUT / "mns.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    log(f"{count} tuiles MNS écrites")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--points", type=int, default=3_000_000, help="nombre de points visé pour la densité standard (points.bin)"
    )
    args = parser.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    zone = shape(json.loads((ROOT / "douvaine.json").read_text())["geometry"])
    to_l93 = Transformer.from_crs(4326, 2154, always_xy=True)
    zone_l93 = shp_transform(to_l93.transform, zone)
    w, s, e, n = zone.bounds
    center = ((w + e) / 2, (s + n) / 2)

    # points-hd : tous les points de la zone, chargés à la demande par la page.
    zref = build_points(zone, zone_l93, center, {"points": args.points, "points-hd": None})
    build_mns(zone, zref)


if __name__ == "__main__":
    main()

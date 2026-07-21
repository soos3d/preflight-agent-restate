/**
 * Client for the free aviationweather.gov Data API (https://aviationweather.gov/data/api/).
 * No API key required. Notable quirks handled here:
 *  - "no data" is HTTP 204 with an empty body, not an empty JSON array
 *  - transient 502/504s from their gateway are real — we just throw and let
 *    Restate's retry policy handle them (no hand-rolled retry loops anywhere)
 *  - G-AIRMET coordinates are strings, SIGMET coordinates are numbers
 */

import type { WeatherBundle } from "./types.js";

const USER_AGENT = "preflight-agent-demo (github.com/soos3d/preflight-agent)";

const baseUrl = (): string =>
  process.env.WEATHER_API_BASE ?? "https://aviationweather.gov/api/data";

/** Optional artificial latency (SLOW_MODE=true) to widen the kill -9 demo window. */
export async function maybeSlow(): Promise<void> {
  if (process.env.SLOW_MODE === "true") {
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}

async function awcJson(path: string, params: Record<string, string>): Promise<unknown[]> {
  const url = new URL(`${baseUrl()}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  // Check the status BEFORE interpreting an empty body: a 5xx with an empty
  // body must throw (so Restate retries), not read as "no data".
  if (!response.ok && response.status !== 204) {
    throw new Error(`aviationweather.gov /${path} returned ${response.status}`);
  }
  const body = await response.text();
  // 204 / empty body means "no data for this query" (e.g. no TAF at a small field).
  if (response.status === 204 || body.trim() === "") {
    return [];
  }
  return JSON.parse(body) as unknown[];
}

type Metar = {
  icaoId: string;
  obsTime: number;
  rawOb: string;
  name?: string;
  fltCat?: string;
  lat?: number;
  lon?: number;
};

type Taf = { icaoId: string; rawTAF: string };

type Pirep = { obsTime: number; rawOb: string; pirepType?: string };

export type Coord = { lat: number; lon: number };

export type SigmetSummary = {
  kind: string;
  hazard: string;
  rawText: string;
  coords: Coord[];
};

export type GairmetSummary = {
  product: string;
  hazard: string;
  level: string | null;
  validTime: string;
  coords: Coord[];
};

export type MetarResult = {
  lines: string[];
  missing: string[];
  coords: Record<string, Coord>;
};

/** Keep only the newest observation per station (hours=2 returns several). */
export function latestPerStation(metars: Metar[]): Metar[] {
  const newest = new Map<string, Metar>();
  for (const metar of metars) {
    const current = newest.get(metar.icaoId);
    if (!current || metar.obsTime > current.obsTime) {
      newest.set(metar.icaoId, metar);
    }
  }
  return [...newest.values()];
}

export async function fetchMetars(stations: string[]): Promise<MetarResult> {
  await maybeSlow();
  const raw = (await awcJson("metar", {
    ids: stations.join(","),
    format: "json",
    hours: "2",
  })) as Metar[];
  const latest = latestPerStation(raw);
  const found = new Set(latest.map((m) => m.icaoId));
  const coords = Object.fromEntries(
    latest
      .filter((m) => typeof m.lat === "number" && typeof m.lon === "number")
      .map((m) => [m.icaoId, { lat: m.lat as number, lon: m.lon as number }]),
  );
  return {
    lines: latest.map((m) => `${m.icaoId}${m.name ? ` (${m.name})` : ""}${m.fltCat ? ` [${m.fltCat}]` : ""}: ${m.rawOb}`),
    missing: stations.filter((s) => !found.has(s)),
    coords,
  };
}

export async function fetchTafs(stations: string[]): Promise<{ lines: string[]; missing: string[] }> {
  await maybeSlow();
  const raw = (await awcJson("taf", { ids: stations.join(","), format: "json" })) as Taf[];
  const found = new Set(raw.map((t) => t.icaoId));
  return {
    lines: raw.map((t) => t.rawTAF),
    missing: stations.filter((s) => !found.has(s)),
  };
}

/**
 * The AWC API has no "along a route" filter, so we search a radius around each
 * airport and de-duplicate — the approach their docs support directly.
 * Note: `icaoId` on PIREPs is often the collecting hub (KWBC), so the raw
 * report text is the only reliable location reference.
 */
export async function fetchPireps(stations: string[], distanceNm = 100): Promise<string[]> {
  await maybeSlow();
  const perStation = await Promise.all(
    stations.map((id) =>
      awcJson("pirep", {
        id,
        distance: String(distanceNm),
        format: "json",
        age: "2",
      }) as Promise<Pirep[]>,
    ),
  );
  const seen = new Set<string>();
  return perStation
    .flat()
    .filter((p) => {
      const key = `${p.obsTime}|${p.rawOb}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => p.rawOb);
}

/** Active domestic SIGMETs (incl. convective). No region filter server-side — see filter below. */
export async function fetchAirSigmets(): Promise<SigmetSummary[]> {
  await maybeSlow();
  const raw = (await awcJson("airsigmet", { format: "json" })) as Record<string, unknown>[];
  return raw.map((s) => ({
    kind: String(s.airSigmetType ?? "SIGMET"),
    hazard: String(s.hazard ?? "UNKNOWN"),
    rawText: String(s.rawAirSigmet ?? "").slice(0, 600),
    coords: normalizeCoords(s.coords),
  }));
}

/** Active G-AIRMETs (the CONUS AIRMET product). Coordinates arrive as strings here. */
export async function fetchGairmets(): Promise<GairmetSummary[]> {
  await maybeSlow();
  const raw = (await awcJson("gairmet", { format: "json" })) as Record<string, unknown>[];
  return raw.map((g) => ({
    product: String(g.product ?? ""),
    hazard: String(g.hazard ?? ""),
    level: g.level == null ? null : String(g.level),
    validTime: String(g.validTime ?? ""),
    coords: normalizeCoords(g.coords),
  }));
}

export function normalizeCoords(value: unknown): Coord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((c) => ({ lat: Number((c as Record<string, unknown>).lat), lon: Number((c as Record<string, unknown>).lon) }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
}

export type Bbox = { minLat: number; maxLat: number; minLon: number; maxLon: number };

/** Bounding box around the route's stations, padded (~1.5° ≈ 90 nm). */
export function routeBbox(coords: Coord[], padDeg = 1.5): Bbox | null {
  if (coords.length === 0) return null;
  const lats = coords.map((c) => c.lat);
  const lons = coords.map((c) => c.lon);
  return {
    minLat: Math.min(...lats) - padDeg,
    maxLat: Math.max(...lats) + padDeg,
    minLon: Math.min(...lons) - padDeg,
    maxLon: Math.max(...lons) + padDeg,
  };
}

export function touchesBbox(coords: Coord[], bbox: Bbox): boolean {
  return coords.some(
    (c) => c.lat >= bbox.minLat && c.lat <= bbox.maxLat && c.lon >= bbox.minLon && c.lon <= bbox.maxLon,
  );
}

/**
 * Keep advisories whose polygon touches the route's bounding box. If we have
 * no station coordinates (all METARs missing), keep everything rather than
 * silently dropping hazard information.
 */
export function filterSigmetsToRoute(sigmets: SigmetSummary[], bbox: Bbox | null): string[] {
  return sigmets
    .filter((s) => bbox === null || touchesBbox(s.coords, bbox))
    .map((s) => `${s.kind} (${s.hazard}): ${s.rawText}`);
}

export function filterGairmetsToRoute(gairmets: GairmetSummary[], bbox: Bbox | null): string[] {
  return gairmets
    .filter((g) => bbox === null || touchesBbox(g.coords, bbox))
    .map((g) => `G-AIRMET ${g.product} ${g.hazard}${formatGairmetLevel(g.level)} valid ${g.validTime}`);
}

/** G-AIRMET `level` is hundreds of feet MSL — render as feet, not a flight level. */
function formatGairmetLevel(level: string | null): string {
  if (level === null) return "";
  return /^\d+$/.test(level) ? ` to ${Number(level) * 100} ft MSL` : ` ${level}`;
}

/** Pure assembly of the five fetch results into the bundle handed to Claude. */
export function assembleWeatherBundle(
  fetchedAtIso: string,
  metars: MetarResult,
  tafs: { lines: string[]; missing: string[] },
  pireps: string[],
  sigmets: SigmetSummary[],
  gairmets: GairmetSummary[],
): WeatherBundle {
  const bbox = routeBbox(Object.values(metars.coords));
  return {
    fetchedAtIso,
    metars: metars.lines,
    tafs: tafs.lines,
    pireps,
    sigmets: filterSigmetsToRoute(sigmets, bbox),
    gairmets: filterGairmetsToRoute(gairmets, bbox),
    missingMetar: metars.missing,
    missingTaf: tafs.missing,
  };
}

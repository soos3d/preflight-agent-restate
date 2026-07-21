import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAirSigmets,
  fetchGairmets,
  fetchMetars,
  fetchPireps,
  fetchTafs,
  filterGairmetsToRoute,
  filterSigmetsToRoute,
  latestPerStation,
  normalizeCoords,
  routeBbox,
  touchesBbox,
  type Coord,
} from "../src/weather.js";
import { fakeAwcFetch, fixture } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const FLORIDA_BBOX = { minLat: 27, maxLat: 32, minLon: -84, maxLon: -80 };

describe("latestPerStation", () => {
  const metars = fixture<{ icaoId: string; obsTime: number }[]>("metars.json");

  it("keeps exactly one observation per station", () => {
    const latest = latestPerStation(metars as never);
    const ids = latest.map((m) => m.icaoId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the newest observation", () => {
    const latest = latestPerStation(metars as never);
    for (const metar of latest) {
      const sameStation = metars.filter((m) => m.icaoId === metar.icaoId);
      expect(metar.obsTime).toBe(Math.max(...sameStation.map((m) => m.obsTime)));
    }
  });

  it("handles an empty list", () => {
    expect(latestPerStation([])).toEqual([]);
  });
});

describe("normalizeCoords", () => {
  it("passes through numeric coords (SIGMET style)", () => {
    expect(normalizeCoords([{ lat: 28.5, lon: -81.3 }])).toEqual([{ lat: 28.5, lon: -81.3 }]);
  });

  it("converts string coords (G-AIRMET style)", () => {
    expect(normalizeCoords([{ lat: "57.03", lon: "-120.94" }])).toEqual([
      { lat: 57.03, lon: -120.94 },
    ]);
  });

  it("drops entries that are not finite numbers", () => {
    expect(normalizeCoords([{ lat: "abc", lon: -80 }, { lat: 28 }])).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeCoords(null)).toEqual([]);
    expect(normalizeCoords("28,-81")).toEqual([]);
  });
});

describe("routeBbox / touchesBbox", () => {
  const kmco: Coord = { lat: 28.42, lon: -81.32 };
  const kjax: Coord = { lat: 30.49, lon: -81.69 };

  it("pads the box around the stations", () => {
    const bbox = routeBbox([kmco, kjax], 1.5);
    expect(bbox).toEqual({
      minLat: 28.42 - 1.5,
      maxLat: 30.49 + 1.5,
      minLon: -81.69 - 1.5,
      maxLon: -81.32 + 1.5,
    });
  });

  it("returns null with no coordinates", () => {
    expect(routeBbox([])).toBeNull();
  });

  it("touchesBbox is true when any point falls inside", () => {
    const bbox = routeBbox([kmco, kjax])!;
    expect(touchesBbox([{ lat: 60, lon: 10 }, { lat: 29.0, lon: -81.5 }], bbox)).toBe(true);
  });

  it("touchesBbox is false when all points are outside", () => {
    const bbox = routeBbox([kmco, kjax])!;
    expect(touchesBbox([{ lat: 45.0, lon: -120.0 }], bbox)).toBe(false);
  });
});

describe("filterSigmetsToRoute / filterGairmetsToRoute", () => {
  const sigmets = [
    { kind: "SIGMET", hazard: "CONVECTIVE", rawText: "CONVECTIVE SIGMET 21E FL GA AL", coords: [{ lat: 29.5, lon: -81.5 }] },
    { kind: "SIGMET", hazard: "TURB", rawText: "SIGMET OVER ROCKIES", coords: [{ lat: 40, lon: -106 }] },
  ];

  it("keeps only advisories touching the route bbox", () => {
    const lines = filterSigmetsToRoute(sigmets, FLORIDA_BBOX);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CONVECTIVE");
  });

  it("keeps everything when bbox is unknown (no station coords)", () => {
    expect(filterSigmetsToRoute(sigmets, null)).toHaveLength(2);
  });

  it("renders gairmet summary lines with product and level", () => {
    const gairmets = [
      { product: "TANGO", hazard: "TURB-LO", level: "080", validTime: "2026-07-21T21:00:00Z", coords: [{ lat: 29, lon: -82 }] },
      { product: "ZULU", hazard: "ICE", level: null, validTime: "2026-07-21T21:00:00Z", coords: [{ lat: 47, lon: -120 }] },
    ];
    const lines = filterGairmetsToRoute(gairmets, FLORIDA_BBOX);
    // level is hundreds of feet MSL — rendered as feet, not a flight level
    expect(lines).toEqual(["G-AIRMET TANGO TURB-LO to 8000 ft MSL valid 2026-07-21T21:00:00Z"]);
  });
});

describe("fetchMetars", () => {
  it("parses the real fixture and reports coords + no missing stations", async () => {
    const { fetch } = fakeAwcFetch({ metar: fixture("metars.json") as unknown[] });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchMetars(["KMCO", "KJAX", "KDAB"]);
    expect(result.missing).toEqual([]);
    expect(result.lines.length).toBe(3);
    expect(result.lines.join("\n")).toContain("METAR KMCO");
    expect(result.coords.KMCO.lat).toBeCloseTo(28.4, 0);
  });

  it("flags stations with no METAR as missing", async () => {
    const { fetch } = fakeAwcFetch({ metar: fixture("metars.json") as unknown[] });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchMetars(["KMCO", "KZZZ"]);
    expect(result.missing).toEqual(["KZZZ"]);
  });

  it("treats HTTP 204 with empty body as no data (AWC's 'no data' contract)", async () => {
    const { fetch } = fakeAwcFetch({ metar: { status: 204, body: "" } });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchMetars(["KZZZ"]);
    expect(result.lines).toEqual([]);
    expect(result.missing).toEqual(["KZZZ"]);
  });

  it("throws on a gateway error so Restate can retry", async () => {
    const { fetch } = fakeAwcFetch({ metar: { status: 504, body: "gateway timeout" } });
    vi.stubGlobal("fetch", fetch);
    await expect(fetchMetars(["KMCO"])).rejects.toThrow(/504/);
  });

  it("throws on a 5xx even when the error body is empty (never read as 'no data')", async () => {
    const { fetch } = fakeAwcFetch({ metar: { status: 502, body: "" } });
    vi.stubGlobal("fetch", fetch);
    await expect(fetchMetars(["KMCO"])).rejects.toThrow(/502/);
  });

  it("sends the ids, format and hours params plus a custom user-agent", async () => {
    let seen: Request | URL | string | undefined;
    vi.stubGlobal("fetch", (async (input: string | URL, init?: RequestInit) => {
      seen = input;
      expect((init?.headers as Record<string, string>)["user-agent"]).toContain("preflight-agent");
      return new Response("[]", { status: 200 });
    }) as typeof fetch);
    await fetchMetars(["KMCO", "KJAX"]);
    const url = new URL(String(seen));
    expect(url.searchParams.get("ids")).toBe("KMCO,KJAX");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("hours")).toBe("2");
  });

  it("honors WEATHER_API_BASE override (used by tests and mocks)", async () => {
    vi.stubEnv("WEATHER_API_BASE", "http://localhost:9999/api/data");
    let seen = "";
    vi.stubGlobal("fetch", (async (input: string | URL) => {
      seen = String(input);
      return new Response("[]", { status: 200 });
    }) as typeof fetch);
    await fetchMetars(["KMCO"]);
    expect(seen).toContain("http://localhost:9999/api/data/metar");
  });
});

describe("fetchTafs", () => {
  it("returns raw TAF strings from the real fixture", async () => {
    const { fetch } = fakeAwcFetch({ taf: fixture("tafs.json") as unknown[] });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchTafs(["KMCO", "KJAX", "KDAB"]);
    expect(result.lines.length).toBe(3);
    expect(result.lines[0]).toContain("TAF");
    expect(result.missing).toEqual([]);
  });

  it("flags small fields without a TAF as missing rather than failing", async () => {
    const { fetch } = fakeAwcFetch({ taf: { status: 204, body: "" } });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchTafs(["X60"]);
    expect(result.lines).toEqual([]);
    expect(result.missing).toEqual(["X60"]);
  });
});

describe("fetchPireps", () => {
  it("queries one radius search per station and de-duplicates reports", async () => {
    const pirep = { obsTime: 1784664420, rawOb: "MCO UA /OV MCO355005/TM 2007/TP B737/RM LIGHT CHOP" };
    const { counts, fetch } = fakeAwcFetch({ pirep: [pirep, pirep] });
    vi.stubGlobal("fetch", fetch);
    const reports = await fetchPireps(["KMCO", "KJAX"]);
    expect(counts.pirep).toBe(2); // one search per station
    expect(reports).toEqual([pirep.rawOb]); // duplicates collapsed
  });

  it("parses the real fixture", async () => {
    const { fetch } = fakeAwcFetch({ pirep: fixture("pireps.json") as unknown[] });
    vi.stubGlobal("fetch", fetch);
    const reports = await fetchPireps(["KMCO"]);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatch(/UA|UUA/); // routine or urgent PIREP markers
  });

  it("returns [] when there are no recent PIREPs", async () => {
    const { fetch } = fakeAwcFetch({ pirep: { status: 204, body: "" } });
    vi.stubGlobal("fetch", fetch);
    expect(await fetchPireps(["KMCO"])).toEqual([]);
  });
});

describe("fetchAirSigmets / fetchGairmets", () => {
  it("summarizes real SIGMETs with numeric coords", async () => {
    const { fetch } = fakeAwcFetch({ airsigmet: fixture("airsigmets.json") as unknown[] });
    vi.stubGlobal("fetch", fetch);
    const sigmets = await fetchAirSigmets();
    expect(sigmets.length).toBeGreaterThan(0);
    expect(sigmets[0].coords[0]).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });
    expect(sigmets[0].rawText.length).toBeLessThanOrEqual(600);
  });

  it("summarizes real G-AIRMETs, converting string coords to numbers", async () => {
    const { fetch } = fakeAwcFetch({ gairmet: fixture("gairmets.json") as unknown[] });
    vi.stubGlobal("fetch", fetch);
    const gairmets = await fetchGairmets();
    expect(gairmets.length).toBeGreaterThan(0);
    for (const g of gairmets) {
      for (const c of g.coords) {
        expect(typeof c.lat).toBe("number");
        expect(Number.isFinite(c.lat)).toBe(true);
      }
    }
  });

  it("returns [] when nothing is active", async () => {
    const { fetch } = fakeAwcFetch({ airsigmet: { status: 204, body: "" }, gairmet: { status: 204, body: "" } });
    vi.stubGlobal("fetch", fetch);
    expect(await fetchAirSigmets()).toEqual([]);
    expect(await fetchGairmets()).toEqual([]);
  });
});

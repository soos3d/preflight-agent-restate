/**
 * Integration tests: the full fetch -> assemble -> prompt -> parse pipeline
 * against a mocked aviationweather.gov (real captured fixtures) and a mocked
 * Anthropic client. No network, no Restate — the workflow wiring itself is
 * covered by the e2e test and the manual recovery demo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { requestBriefing, requestReBrief, renderWeatherText, DEFAULT_MODEL } from "../src/briefing.js";
import {
  assembleWeatherBundle,
  fetchAirSigmets,
  fetchGairmets,
  fetchMetars,
  fetchPireps,
  fetchTafs,
} from "../src/weather.js";
import type { BriefingRequest, WeatherBundle } from "../src/types.js";
import { fakeAwcFetch, fixture, sampleBriefing, sampleReBriefChanged, stubClient } from "./helpers.js";

const request: BriefingRequest = {
  departure: "KMCO",
  destination: "KJAX",
  alternate: "KDAB",
  etdIso: "2026-07-22T14:00:00Z",
  flightRules: "VFR",
};
const stations = ["KMCO", "KJAX", "KDAB"];

afterEach(() => vi.unstubAllGlobals());

async function fetchBundle(): Promise<{ bundle: WeatherBundle; counts: Record<string, number> }> {
  const { counts, fetch } = fakeAwcFetch({
    metar: fixture("metars.json") as unknown[],
    taf: fixture("tafs.json") as unknown[],
    pirep: fixture("pireps.json") as unknown[],
    airsigmet: fixture("airsigmets.json") as unknown[],
    gairmet: fixture("gairmets.json") as unknown[],
  });
  vi.stubGlobal("fetch", fetch);
  // Same parallel fan-out shape as the workflow (there each is a journaled ctx.run).
  const [metars, tafs, pireps, sigmets, gairmets] = await Promise.all([
    fetchMetars(stations),
    fetchTafs(stations),
    fetchPireps(stations),
    fetchAirSigmets(),
    fetchGairmets(),
  ]);
  return { bundle: assembleWeatherBundle("2026-07-21T20:00:00Z", metars, tafs, pireps, sigmets, gairmets), counts };
}

describe("weather bundle assembly from real fixtures", () => {
  it("builds a complete bundle with one line per station", async () => {
    const { bundle } = await fetchBundle();
    expect(bundle.metars).toHaveLength(3);
    expect(bundle.tafs).toHaveLength(3);
    expect(bundle.missingMetar).toEqual([]);
    expect(bundle.missingTaf).toEqual([]);
    expect(bundle.pireps.length).toBeGreaterThan(0);
  });

  it("geo-filters SIGMETs/G-AIRMETs to the Florida route", async () => {
    const { bundle } = await fetchBundle();
    const allSigmets = fixture<unknown[]>("airsigmets.json").length;
    const allGairmets = fixture<unknown[]>("gairmets.json").length;
    // The fixtures span the whole CONUS; the route bbox must drop some of them.
    expect(bundle.sigmets.length).toBeLessThan(allSigmets);
    expect(bundle.gairmets.length).toBeLessThan(allGairmets);
  });

  it("makes exactly one request per endpoint plus one PIREP search per station", async () => {
    const { counts } = await fetchBundle();
    expect(counts).toEqual({ metar: 1, taf: 1, pirep: 3, airsigmet: 1, gairmet: 1 });
  });

  it("renders a prompt containing raw observations from every section", async () => {
    const { bundle } = await fetchBundle();
    const text = renderWeatherText(stations, bundle);
    expect(text).toContain("METAR KMCO");
    expect(text).toContain("TAF KMCO");
    expect(text).toMatch(/## PIREPs/);
  });
});

describe("briefing round-trip with mocked Anthropic", () => {
  it("produces a validated briefing from live-captured weather", async () => {
    const { bundle } = await fetchBundle();
    const capture: { lastRequest?: unknown } = {};
    const briefing = await requestBriefing(stubClient(sampleBriefing, capture), DEFAULT_MODEL, request, stations, bundle);
    expect(briefing.recommendation).toBe("GO_WITH_CAUTION");
    const params = capture.lastRequest as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.messages[0].content).toContain("METAR KMCO");
  });

  it("produces a validated re-brief that flags the change", async () => {
    const { bundle } = await fetchBundle();
    const rebrief = await requestReBrief(
      stubClient(sampleReBriefChanged), DEFAULT_MODEL, request, stations, sampleBriefing, bundle,
    );
    expect(rebrief.changed).toBe(true);
    expect(rebrief.recommendation).toBe("NO_GO");
  });
});

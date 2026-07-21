import { describe, expect, it } from "vitest";
import { parseBriefingRequest, stationsOf } from "../src/validation.js";

const NOW = Date.parse("2026-07-21T12:00:00Z");

const valid = {
  departure: "KMCO",
  destination: "KJAX",
  alternate: "KDAB",
  etdIso: "2026-07-22T14:00:00Z",
  flightRules: "VFR",
  aircraft: "PA-28",
};

describe("parseBriefingRequest", () => {
  it("accepts a fully valid request", () => {
    const request = parseBriefingRequest(valid, NOW);
    expect(request.departure).toBe("KMCO");
    expect(request.alternate).toBe("KDAB");
  });

  it("accepts a request without optional fields", () => {
    const { alternate, aircraft, ...minimal } = valid;
    const request = parseBriefingRequest(minimal, NOW);
    expect(request.alternate).toBeUndefined();
    expect(request.aircraft).toBeUndefined();
  });

  it("accepts 3-letter identifiers", () => {
    expect(() => parseBriefingRequest({ ...valid, departure: "X60" }, NOW)).not.toThrow();
  });

  it("accepts IFR flight rules", () => {
    expect(parseBriefingRequest({ ...valid, flightRules: "IFR" }, NOW).flightRules).toBe("IFR");
  });

  it.each([
    ["lowercase ident", { ...valid, departure: "kmco" }],
    ["too short", { ...valid, departure: "KM" }],
    ["too long", { ...valid, destination: "KMCOX" }],
    ["punctuation", { ...valid, destination: "KM-O" }],
    ["bad alternate", { ...valid, alternate: "kdab!" }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseBriefingRequest(input, NOW)).toThrow(/Invalid briefing request/);
  });

  it("rejects a malformed ETD", () => {
    expect(() => parseBriefingRequest({ ...valid, etdIso: "tomorrow at 2" }, NOW)).toThrow(
      /etdIso/,
    );
  });

  it("rejects an ETD in the past", () => {
    expect(() =>
      parseBriefingRequest({ ...valid, etdIso: "2026-07-21T11:00:00Z" }, NOW),
    ).toThrow(/future/);
  });

  it("rejects an ETD equal to now", () => {
    expect(() =>
      parseBriefingRequest({ ...valid, etdIso: "2026-07-21T12:00:00.000Z" }, NOW),
    ).toThrow(/future/);
  });

  it("rejects unknown flight rules", () => {
    expect(() => parseBriefingRequest({ ...valid, flightRules: "SVFR" }, NOW)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => parseBriefingRequest({ departure: "KMCO" }, NOW)).toThrow(/Invalid/);
  });

  it("rejects non-object input", () => {
    expect(() => parseBriefingRequest("KMCO to KJAX", NOW)).toThrow(/Invalid/);
  });

  it("reports all offending fields in the message", () => {
    try {
      parseBriefingRequest({ ...valid, departure: "x", destination: "y" }, NOW);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("departure");
      expect(String(error)).toContain("destination");
    }
  });
});

describe("stationsOf", () => {
  it("returns departure, destination, alternate in order", () => {
    expect(stationsOf(parseBriefingRequest(valid, NOW))).toEqual(["KMCO", "KJAX", "KDAB"]);
  });

  it("omits a missing alternate", () => {
    const { alternate, ...rest } = valid;
    expect(stationsOf(parseBriefingRequest(rest, NOW))).toEqual(["KMCO", "KJAX"]);
  });

  it("de-duplicates repeated stations (round robin)", () => {
    const roundRobin = { ...valid, destination: "KMCO", alternate: "KJAX" };
    expect(stationsOf(parseBriefingRequest(roundRobin, NOW))).toEqual(["KMCO", "KJAX"]);
  });
});

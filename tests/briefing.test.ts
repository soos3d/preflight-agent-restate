import Anthropic from "@anthropic-ai/sdk";
import { TerminalError } from "@restatedev/restate-sdk";
import { describe, expect, it } from "vitest";
import {
  briefingSchema,
  DEFAULT_MODEL,
  modelFromEnv,
  rebriefSchema,
  renderFlightText,
  renderWeatherText,
  requestBriefing,
  requestReBrief,
  type BriefingModelClient,
} from "../src/briefing.js";
import type { BriefingRequest, WeatherBundle } from "../src/types.js";
import {
  emptyWeather,
  sampleBriefing,
  sampleReBriefChanged,
  sampleReBriefUnchanged,
  stubClient,
} from "./helpers.js";

const request: BriefingRequest = {
  departure: "KMCO",
  destination: "KJAX",
  alternate: "KDAB",
  etdIso: "2026-07-22T14:00:00Z",
  flightRules: "VFR",
  aircraft: "PA-28",
};
const stations = ["KMCO", "KJAX", "KDAB"];

const weather: WeatherBundle = {
  ...emptyWeather,
  metars: ["KMCO (Orlando Intl) [VFR]: METAR KMCO 211953Z 18012G19KT 10SM FEW050 36/22 A3000"],
  tafs: ["TAF KMCO 211728Z 2118/2224 17014G20KT P6SM FEW035"],
  sigmets: ["SIGMET (CONVECTIVE): CONVECTIVE SIGMET 21E VALID UNTIL 2155Z FL GA AL"],
  missingTaf: ["KDAB"],
};

describe("renderFlightText", () => {
  it("includes route, ETD, rules and aircraft", () => {
    const text = renderFlightText(request);
    expect(text).toContain("KMCO -> KJAX");
    expect(text).toContain("Alternate: KDAB");
    expect(text).toContain("2026-07-22T14:00:00Z");
    expect(text).toContain("VFR");
    expect(text).toContain("PA-28");
  });

  it("omits optional lines when absent", () => {
    const { alternate, aircraft, ...minimal } = request;
    const text = renderFlightText(minimal as BriefingRequest);
    expect(text).not.toContain("Alternate");
    expect(text).not.toContain("Aircraft");
  });
});

describe("renderWeatherText", () => {
  it("includes the raw METAR/TAF text verbatim", () => {
    const text = renderWeatherText(stations, weather);
    expect(text).toContain("METAR KMCO 211953Z 18012G19KT");
    expect(text).toContain("TAF KMCO");
    expect(text).toContain("CONVECTIVE SIGMET 21E");
  });

  it("explicitly notes stations with no TAF (never silently omitted)", () => {
    const text = renderWeatherText(stations, weather);
    expect(text).toContain("no TAF available for KDAB");
  });

  it("explicitly notes stations with no METAR", () => {
    const text = renderWeatherText(stations, { ...weather, missingMetar: ["KDAB"] });
    expect(text).toContain("no METAR available for KDAB");
  });

  it("marks empty sections instead of dropping them", () => {
    const text = renderWeatherText(stations, emptyWeather);
    expect(text).toContain("(no recent PIREPs)");
    expect(text).toContain("(no active SIGMETs near route)");
    expect(text).toContain("(no active G-AIRMETs near route)");
  });

  it("states when the weather was fetched", () => {
    expect(renderWeatherText(stations, weather)).toContain(weather.fetchedAtIso);
  });
});

describe("briefingSchema", () => {
  it("accepts a well-formed briefing", () => {
    expect(briefingSchema.parse(sampleBriefing)).toEqual(sampleBriefing);
  });

  it.each([
    ["bad recommendation", { ...sampleBriefing, recommendation: "MAYBE" }],
    ["bad severity", { ...sampleBriefing, hazards: [{ type: "wind", detail: "x", severity: "extreme" }] }],
    ["empty summary", { ...sampleBriefing, summary: "" }],
    ["missing reasoning", { ...sampleBriefing, reasoning: undefined }],
  ])("rejects %s", (_name, bad) => {
    expect(() => briefingSchema.parse(bad)).toThrow();
  });
});

describe("rebriefSchema (changed/unchanged diff handling)", () => {
  it("accepts an unchanged re-brief with empty changeSummary", () => {
    expect(rebriefSchema.parse(sampleReBriefUnchanged).changed).toBe(false);
  });

  it("accepts a changed re-brief carrying the new recommendation", () => {
    const parsed = rebriefSchema.parse(sampleReBriefChanged);
    expect(parsed.changed).toBe(true);
    expect(parsed.recommendation).toBe("NO_GO");
    expect(parsed.changeSummary).toContain("SIGMET");
  });

  it("rejects a re-brief without the changed flag", () => {
    expect(() => rebriefSchema.parse(sampleBriefing)).toThrow();
  });
});

describe("requestBriefing", () => {
  it("returns the parsed briefing from the model response", async () => {
    const briefing = await requestBriefing(stubClient(sampleBriefing), DEFAULT_MODEL, request, stations, weather);
    expect(briefing).toEqual(sampleBriefing);
  });

  it("sends the flight, the raw weather, and a structured-output schema", async () => {
    const capture: { lastRequest?: unknown } = {};
    await requestBriefing(stubClient(sampleBriefing, capture), DEFAULT_MODEL, request, stations, weather);
    const params = capture.lastRequest as Anthropic.MessageCreateParamsNonStreaming;
    const userText = params.messages[0].content as string;
    expect(userText).toContain("KMCO -> KJAX");
    expect(userText).toContain("METAR KMCO 211953Z");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.system).toContain("CFI");
    expect(params.model).toBe(DEFAULT_MODEL);
  });

  it("rejects a model response that fails schema validation", async () => {
    const bad = { ...sampleBriefing, recommendation: "SURE" };
    await expect(
      requestBriefing(stubClient(bad), DEFAULT_MODEL, request, stations, weather),
    ).rejects.toThrow();
  });

  it("converts non-retryable API errors into TerminalError", async () => {
    const failing: BriefingModelClient = {
      messages: {
        create: async () => {
          throw new Anthropic.BadRequestError(
            400,
            { type: "error", error: { type: "invalid_request_error", message: "bad model" } },
            "bad model",
            new Headers(),
          );
        },
      },
    };
    await expect(
      requestBriefing(failing, DEFAULT_MODEL, request, stations, weather),
    ).rejects.toThrow(TerminalError);
  });

  it.each([
    [429, Anthropic.RateLimitError],
    [500, Anthropic.InternalServerError],
  ])("rethrows %s errors unchanged so Restate retries them", async (status, ErrorClass) => {
    const failing: BriefingModelClient = {
      messages: {
        create: async () => {
          throw new ErrorClass(
            status,
            { type: "error", error: { type: "api_error", message: "try later" } },
            "try later",
            new Headers(),
          );
        },
      },
    };
    await expect(requestBriefing(failing, DEFAULT_MODEL, request, stations, weather)).rejects.toThrow(
      ErrorClass,
    );
  });
});

describe("requestReBrief", () => {
  it("sends both the original briefing and the fresh weather", async () => {
    const capture: { lastRequest?: unknown } = {};
    await requestReBrief(
      stubClient(sampleReBriefChanged, capture), DEFAULT_MODEL, request, stations, sampleBriefing, weather,
    );
    const params = capture.lastRequest as Anthropic.MessageCreateParamsNonStreaming;
    const userText = params.messages[0].content as string;
    expect(userText).toContain("Original briefing");
    expect(userText).toContain(sampleBriefing.summary);
    expect(userText).toContain("Fresh weather");
    expect(userText).toContain("METAR KMCO 211953Z");
  });

  it("returns the parsed re-brief with the diff fields", async () => {
    const rebrief = await requestReBrief(
      stubClient(sampleReBriefUnchanged), DEFAULT_MODEL, request, stations, sampleBriefing, weather,
    );
    expect(rebrief.changed).toBe(false);
  });
});

describe("modelFromEnv", () => {
  it("defaults to a current Sonnet-class model", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(modelFromEnv()).toBe(process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL);
  });
});

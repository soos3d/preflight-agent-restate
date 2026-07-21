import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Briefing, ReBrief, WeatherBundle } from "../src/types.js";
import type { BriefingModelClient } from "../src/briefing.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

export function fixtureText(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

export const sampleBriefing: Briefing = {
  summary:
    "VFR conditions prevail along the route. KMCO reports winds 180 at 12 gusting 19, visibility 10+, few clouds at 5,000. KJAX similar. Expect afternoon convective buildups.",
  hazards: [
    { type: "convective", detail: "Isolated afternoon thunderstorms forecast after 20Z near KJAX", severity: "moderate" },
  ],
  recommendation: "GO_WITH_CAUTION",
  reasoning: "Conditions are VFR now, but forecast convective activity near the destination warrants monitoring en route.",
  validAsOfIso: "2026-07-21T20:00:00Z",
};

export const sampleReBriefUnchanged: ReBrief = {
  ...sampleBriefing,
  summary: "Conditions remain VFR and consistent with the original briefing.",
  changed: false,
  changeSummary: "",
};

export const sampleReBriefChanged: ReBrief = {
  ...sampleBriefing,
  summary: "TAF now shows thunderstorms at the destination after 14Z.",
  recommendation: "NO_GO",
  changed: true,
  changeSummary: "Convective SIGMET now active over KJAX; TAF shows TS after 14Z.",
};

export const emptyWeather: WeatherBundle = {
  fetchedAtIso: "2026-07-21T20:00:00Z",
  metars: [],
  tafs: [],
  pireps: [],
  sigmets: [],
  gairmets: [],
  missingMetar: [],
  missingTaf: [],
};

/** Anthropic client stub that returns `payload` as the structured-output text block. */
export function stubClient(payload: unknown, capture?: { lastRequest?: unknown }): BriefingModelClient {
  return {
    messages: {
      create: async (params) => {
        if (capture) capture.lastRequest = params;
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: JSON.stringify(payload), citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      },
    },
  };
}

type FakeRoute = { status: number; body: string };

/**
 * Replaces global fetch with a dispatcher keyed on the last path segment
 * (metar, taf, pirep, airsigmet, gairmet). Returns a hit counter per route.
 */
export function fakeAwcFetch(routes: Record<string, FakeRoute | unknown[]>): {
  counts: Record<string, number>;
  fetch: typeof fetch;
} {
  const counts: Record<string, number> = {};
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/").pop() ?? "";
    counts[endpoint] = (counts[endpoint] ?? 0) + 1;
    const route = routes[endpoint];
    if (route === undefined) {
      return new Response("not found", { status: 404 });
    }
    const { status, body } = Array.isArray(route)
      ? { status: 200, body: JSON.stringify(route) }
      : route;
    // 204 is a null-body status — the Response constructor rejects a body for it.
    return new Response(status === 204 ? null : body, { status });
  }) as typeof fetch;
  return { counts, fetch: fake };
}

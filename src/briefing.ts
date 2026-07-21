import Anthropic from "@anthropic-ai/sdk";
import { TerminalError } from "@restatedev/restate-sdk";
import { z } from "zod";
import type { Briefing, BriefingRequest, ReBrief, WeatherBundle } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-5";

/** Minimal interface so tests can stub the Anthropic client. */
export type BriefingModelClient = {
  messages: { create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message> };
};

export function createAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — see .env.example");
  }
  return new Anthropic();
}

export function modelFromEnv(): string {
  return process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
}

const hazardSchema = z.object({
  type: z.string(),
  detail: z.string(),
  severity: z.enum(["low", "moderate", "high"]),
});

export const briefingSchema = z.object({
  summary: z.string().min(1),
  hazards: z.array(hazardSchema),
  recommendation: z.enum(["GO", "GO_WITH_CAUTION", "NO_GO"]),
  reasoning: z.string().min(1),
  validAsOfIso: z.string(),
});

export const rebriefSchema = briefingSchema.extend({
  changed: z.boolean(),
  changeSummary: z.string(),
});

// JSON Schema handed to the API's structured-output mode — guarantees the
// response text is valid JSON matching this shape. Zod re-validates on our side.
const BRIEFING_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "3-6 sentences, plain language, pilot-appropriate" },
    hazards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "e.g. IFR ceilings, wind, convective, icing, turbulence" },
          detail: { type: "string" },
          severity: { type: "string", enum: ["low", "moderate", "high"] },
        },
        required: ["type", "detail", "severity"],
        additionalProperties: false,
      },
    },
    recommendation: { type: "string", enum: ["GO", "GO_WITH_CAUTION", "NO_GO"] },
    reasoning: { type: "string", description: "2-4 sentences" },
    validAsOfIso: { type: "string" },
  },
  required: ["summary", "hazards", "recommendation", "reasoning", "validAsOfIso"],
  additionalProperties: false,
} as const;

const REBRIEF_JSON_SCHEMA = {
  ...BRIEFING_JSON_SCHEMA,
  properties: {
    ...BRIEFING_JSON_SCHEMA.properties,
    changed: { type: "boolean", description: "true if conditions changed materially since the original briefing" },
    changeSummary: { type: "string", description: "What changed and why it matters; empty string if unchanged" },
  },
  required: [...BRIEFING_JSON_SCHEMA.required, "changed", "changeSummary"],
} as const;

const SYSTEM_PROMPT = `You are an experienced Gold Seal CFI giving a preflight weather briefing to a private pilot.
Brief the way a careful instructor would: plain language, concrete numbers, no fluff.

Rules:
- Cite the actual METAR/TAF values (winds, visibility, ceilings, times) from the data provided.
- Never invent data that is not in the input. If data for a station is unavailable, say so explicitly.
- Frame the go/no-go call for the stated flight rules (VFR vs IFR) — VFR minimums and personal-minimum
  caution for VFR flights; for IFR, cover approach considerations, whether an alternate is required
  (1-2-3 rule), and give extra weight to icing and IFR-conditions advisories.
- Convective SIGMETs along the route are a serious hazard for light aircraft; treat them accordingly.
- This is a training/demo briefing, not an official weather briefing.`;

export function renderWeatherText(stations: string[], weather: WeatherBundle): string {
  const section = (title: string, lines: string[], emptyNote: string): string =>
    `## ${title}\n${lines.length > 0 ? lines.join("\n") : emptyNote}`;
  const missingNotes = [
    ...weather.missingMetar.map((s) => `NOTE: no METAR available for ${s}`),
    ...weather.missingTaf.map((s) => `NOTE: no TAF available for ${s} (common at small fields)`),
  ];
  return [
    `Weather fetched at ${weather.fetchedAtIso} for stations: ${stations.join(", ")}`,
    section("METARs", weather.metars, "(none available)"),
    section("TAFs", weather.tafs, "(none available)"),
    section("PIREPs near route", weather.pireps, "(no recent PIREPs)"),
    section("SIGMETs near route", weather.sigmets, "(no active SIGMETs near route)"),
    section("G-AIRMETs near route", weather.gairmets, "(no active G-AIRMETs near route)"),
    ...(missingNotes.length > 0 ? [missingNotes.join("\n")] : []),
  ].join("\n\n");
}

export function renderFlightText(request: BriefingRequest): string {
  return [
    `Flight: ${request.departure} -> ${request.destination}`,
    request.alternate ? `Alternate: ${request.alternate}` : null,
    `Planned departure (ETD): ${request.etdIso}`,
    `Flight rules: ${request.flightRules}`,
    request.aircraft ? `Aircraft: ${request.aircraft}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function callClaude(
  client: BriefingModelClient,
  model: string,
  userText: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      // Briefings should be fast and cheap; the structure comes from the schema.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema } },
    });
    const text = response.content.find((block) => block.type === "text");
    if (!text) {
      throw new Error(`Claude returned no text block (stop_reason: ${response.stop_reason})`);
    }
    return JSON.parse(text.text);
  } catch (error) {
    // Non-retryable API errors (bad request, auth, content policy) must fail the
    // workflow terminally instead of retrying forever. Everything else (429, 5xx,
    // network) is rethrown and handled by Restate's retry policy.
    if (error instanceof Anthropic.APIError && typeof error.status === "number") {
      const retryable = error.status === 429 || error.status >= 500;
      if (!retryable) {
        throw new TerminalError(`Claude request failed permanently: ${error.message}`);
      }
    }
    throw error;
  }
}

export async function requestBriefing(
  client: BriefingModelClient,
  model: string,
  request: BriefingRequest,
  stations: string[],
  weather: WeatherBundle,
): Promise<Briefing> {
  const userText = [
    "Produce a preflight weather briefing for this flight.",
    renderFlightText(request),
    renderWeatherText(stations, weather),
  ].join("\n\n");
  const raw = await callClaude(client, model, userText, BRIEFING_JSON_SCHEMA as unknown as Record<string, unknown>);
  return briefingSchema.parse(raw);
}

export async function requestReBrief(
  client: BriefingModelClient,
  model: string,
  request: BriefingRequest,
  stations: string[],
  original: Briefing,
  freshWeather: WeatherBundle,
): Promise<ReBrief> {
  const userText = [
    "This flight was briefed earlier and departs in about one hour. Compare the fresh weather below " +
      "against the original briefing. Set changed=true only for material changes a pilot must re-evaluate " +
      "(new convective activity, ceilings/visibility dropping across a category, significant wind shifts, " +
      "new icing) — not routine METAR churn. recommendation is your NEW recommendation.",
    renderFlightText(request),
    `## Original briefing (issued ${original.validAsOfIso})\n${JSON.stringify(original, null, 2)}`,
    `# Fresh weather\n${renderWeatherText(stations, freshWeather)}`,
  ].join("\n\n");
  const raw = await callClaude(client, model, userText, REBRIEF_JSON_SCHEMA as unknown as Record<string, unknown>);
  return rebriefSchema.parse(raw);
}

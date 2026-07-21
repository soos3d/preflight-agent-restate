import { z } from "zod";
import type { BriefingRequest } from "./types.js";

const ICAO_REGEX = /^[A-Z0-9]{3,4}$/;

const icao = z
  .string()
  .regex(ICAO_REGEX, "must be a 3-4 character ICAO identifier, e.g. KMCO");

export const briefingRequestSchema = z.object({
  departure: icao,
  destination: icao,
  alternate: icao.optional(),
  etdIso: z.iso.datetime({ offset: true }),
  flightRules: z.enum(["VFR", "IFR"]),
  aircraft: z.string().max(80).optional(),
});

/**
 * Validates the raw workflow input. Throws a plain Error with a readable
 * message on failure — the workflow converts it into a Restate TerminalError
 * (invalid input should fail the invocation, never be retried).
 */
export function parseBriefingRequest(input: unknown, nowMs: number): BriefingRequest {
  const result = briefingRequestSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid briefing request — ${detail}`);
  }
  const request = result.data;
  if (Date.parse(request.etdIso) <= nowMs) {
    throw new Error(`Invalid briefing request — etdIso must be in the future`);
  }
  return request;
}

/** The stations to brief, in a stable order, without duplicates. */
export function stationsOf(request: BriefingRequest): string[] {
  return [...new Set([request.departure, request.destination, request.alternate].filter(
    (s): s is string => s !== undefined,
  ))];
}

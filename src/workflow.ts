/**
 * THE WHOLE DEMO IS THIS FILE.
 *
 * Every durable-execution pattern lives here, in the order the README walks
 * them:
 *   1. journaled side effects + parallel fan-out ....... fetchWeather()
 *   2. journaled LLM call (never billed twice) ......... "claude briefing"
 *   3. human-in-the-loop: suspend on a durable promise . "pilot-ack"
 *   4. durable timer to ETD - 1h (survives restarts) ... ctx.sleep()
 *   5. re-fetch + Claude diff vs the original .......... "claude re-brief"
 *   6. queryable workflow state ........................ ctx.set / getStatus
 *
 * Everything imported below is ordinary non-Restate plumbing: the
 * aviationweather.gov client (weather.ts), the Claude prompts and schemas
 * (briefing.ts), and input validation (validation.ts).
 */
import * as restate from "@restatedev/restate-sdk";
import { RestatePromise, TerminalError } from "@restatedev/restate-sdk";
import {
  createAnthropicClient,
  modelFromEnv,
  requestBriefing,
  requestReBrief,
} from "./briefing.js";
import type { Briefing, BriefingRequest, BriefingStatus, ReBrief, WeatherBundle } from "./types.js";
import { parseBriefingRequest, stationsOf } from "./validation.js";
import {
  assembleWeatherBundle,
  fetchAirSigmets,
  fetchGairmets,
  fetchMetars,
  fetchPireps,
  fetchTafs,
} from "./weather.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Fan out all five weather fetches in parallel. Each `ctx.run` is a journaled
 * side effect: its result is recorded in Restate's journal, so on retry or
 * crash recovery completed fetches are REPLAYED from the journal, not
 * re-executed. Restate's default retry policy (infinite, exponential backoff)
 * handles aviationweather.gov's transient 502/504s — no retry code here.
 *
 * NOTE: `RestatePromise.all` (not `Promise.all`) — Restate journals completion
 * order so replay stays deterministic.
 */
async function fetchWeather(
  ctx: restate.WorkflowContext,
  label: string,
  stations: string[],
): Promise<WeatherBundle> {
  const fetchedAtIso = new Date(await ctx.date.now()).toISOString();
  const [metars, tafs, pireps, sigmets, gairmets] = await RestatePromise.all([
    ctx.run(`${label}: fetch METARs`, async () => {
      const result = await fetchMetars(stations);
      console.log(`[side effect] ${label}: fetched ${result.lines.length} METARs`);
      return result;
    }),
    ctx.run(`${label}: fetch TAFs`, async () => {
      const result = await fetchTafs(stations);
      console.log(`[side effect] ${label}: fetched ${result.lines.length} TAFs`);
      return result;
    }),
    ctx.run(`${label}: fetch PIREPs`, async () => {
      const result = await fetchPireps(stations);
      console.log(`[side effect] ${label}: fetched ${result.length} PIREPs`);
      return result;
    }),
    ctx.run(`${label}: fetch SIGMETs`, async () => {
      const result = await fetchAirSigmets();
      console.log(`[side effect] ${label}: fetched ${result.length} SIGMETs`);
      return result;
    }),
    ctx.run(`${label}: fetch G-AIRMETs`, async () => {
      const result = await fetchGairmets();
      console.log(`[side effect] ${label}: fetched ${result.length} G-AIRMETs`);
      return result;
    }),
  ]);
  // Pure post-processing on journaled data — deterministic, so no ctx.run needed.
  return assembleWeatherBundle(fetchedAtIso, metars, tafs, pireps, sigmets, gairmets);
}

export const briefingWorkflow = restate.workflow({
  name: "briefing",
  handlers: {
    /** Runs exactly once per briefing ID. Kill the process anywhere — it resumes here. */
    run: async (ctx: restate.WorkflowContext, input: unknown): Promise<string> => {
      let request: BriefingRequest;
      try {
        request = parseBriefingRequest(input, await ctx.date.now());
      } catch (error) {
        // Bad input is a terminal error: fail the invocation, never retry.
        throw new TerminalError((error as Error).message);
      }
      ctx.set("request", request);
      ctx.set("phase", "FETCHING_WEATHER");
      const stations = stationsOf(request);

      // Step 1: parallel journaled weather fetch.
      const weather = await fetchWeather(ctx, "initial", stations);

      // Step 2: the LLM call is journaled too — on recovery the briefing is
      // replayed from the journal instead of paying for a second Claude call.
      const briefing = await ctx.run("claude briefing", async (): Promise<Briefing> => {
        const result = await requestBriefing(createAnthropicClient(), modelFromEnv(), request, stations, weather);
        console.log(`[side effect] Claude briefing complete: ${result.recommendation}`);
        return result;
      });
      ctx.set("briefing", briefing);
      ctx.set("phase", "AWAITING_ACK");

      // Step 3: human in the loop. Awaiting a durable promise SUSPENDS the
      // workflow — zero resources consumed until the `ack` handler resolves it.
      // (Restate's AI docs call this the pause-and-resume approval pattern.)
      await ctx.promise<boolean>("pilot-ack");
      ctx.set("phase", "WAITING_FOR_REBRIEF_WINDOW");

      // Step 4: durable timer until ETD - 1h. Survives process AND server
      // restarts; if the ETD is less than an hour out, re-brief immediately.
      const delayMs = Date.parse(request.etdIso) - ONE_HOUR_MS - (await ctx.date.now());
      if (delayMs > 0) {
        await ctx.sleep(delayMs, "wait until ETD - 1h");
      }
      ctx.set("phase", "REBRIEFING");

      // Step 5: re-fetch and have Claude diff conditions against the original.
      const freshWeather = await fetchWeather(ctx, "rebrief", stations);
      const rebrief = await ctx.run("claude re-brief", async (): Promise<ReBrief> => {
        const result = await requestReBrief(
          createAnthropicClient(), modelFromEnv(), request, stations, briefing, freshWeather,
        );
        console.log(`[side effect] Claude re-brief complete: changed=${result.changed}`);
        return result;
      });
      ctx.set("rebrief", rebrief);

      // Step 6: material change -> require a second acknowledgment.
      if (rebrief.changed) {
        ctx.set("phase", "AWAITING_REACK");
        await ctx.promise<boolean>("pilot-reack");
        ctx.set("phase", "RE_ACKNOWLEDGED");
        return "RE_ACKNOWLEDGED";
      }
      ctx.set("phase", "UNCHANGED_CONFIRMED");
      return "UNCHANGED_CONFIRMED";
    },

    /** Pilot acknowledges the initial briefing — resolves the durable promise. */
    ack: async (ctx: restate.WorkflowSharedContext): Promise<void> => {
      const promise = ctx.promise<boolean>("pilot-ack");
      if ((await promise.peek()) === undefined) {
        await promise.resolve(true);
      }
    },

    /** Pilot acknowledges the re-brief after a material change. */
    reAck: async (ctx: restate.WorkflowSharedContext): Promise<void> => {
      const promise = ctx.promise<boolean>("pilot-reack");
      if ((await promise.peek()) === undefined) {
        await promise.resolve(true);
      }
    },

    /** Shared read path — powers the pilot UI. Runs concurrently with `run`. */
    getStatus: async (ctx: restate.WorkflowSharedContext): Promise<BriefingStatus> => {
      return {
        phase: (await ctx.get<BriefingStatus["phase"]>("phase")) ?? null,
        request: (await ctx.get<BriefingRequest>("request")) ?? null,
        briefing: (await ctx.get<Briefing>("briefing")) ?? null,
        rebrief: (await ctx.get<ReBrief>("rebrief")) ?? null,
      };
    },
  },
});

export type BriefingWorkflow = typeof briefingWorkflow;

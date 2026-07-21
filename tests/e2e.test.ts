/**
 * True end-to-end test: a real Restate server (via testcontainers/Docker) runs
 * the actual workflow; aviationweather.gov and the Anthropic API are replaced
 * by a local mock server via WEATHER_API_BASE / ANTHROPIC_BASE_URL.
 *
 * `alwaysReplay` forces Restate to replay the journal at every suspension
 * point — the mock-server hit counters then prove that journaled side effects
 * (weather fetches, Claude calls) are replayed, NOT re-executed.
 *
 * Run with:  npm run test:e2e   (requires Docker)
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { briefingWorkflow } from "../src/workflow.js";
import type { BriefingStatus } from "../src/types.js";
import { fixtureText, sampleBriefing, sampleReBriefChanged, sampleReBriefUnchanged } from "./helpers.js";

const TIMEOUT = 180_000;

describe.runIf(process.env.RUN_E2E === "1")("e2e (Docker required)", () => {
  let env: RestateTestEnvironment;
  let mock: Server;
  let ingress: clients.Ingress;
  const hits: Record<string, number> = {};
  // The mock decides the re-brief outcome per test.
  let rebriefChanged = false;

  beforeAll(async () => {
    mock = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      hits[path] = (hits[path] ?? 0) + 1;
      if (path.startsWith("/api/data/")) {
        const endpoint = path.split("/").pop() ?? "";
        const file: Record<string, string> = {
          metar: "metars.json", taf: "tafs.json", pirep: "pireps.json",
          airsigmet: "airsigmets.json", gairmet: "gairmets.json",
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtureText(file[endpoint]));
        return;
      }
      if (path === "/anthropic/v1/messages") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();
        const isRebrief = body.includes("Fresh weather");
        const payload = isRebrief
          ? (rebriefChanged ? sampleReBriefChanged : sampleReBriefUnchanged)
          : sampleBriefing;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_e2e", type: "message", role: "assistant", model: "claude-sonnet-5",
          content: [{ type: "text", text: JSON.stringify(payload) }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mock.listen(0, resolve));
    const port = (mock.address() as AddressInfo).port;
    process.env.WEATHER_API_BASE = `http://localhost:${port}/api/data`;
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}/anthropic`;
    process.env.ANTHROPIC_API_KEY = "test-key";

    env = await RestateTestEnvironment.start({
      services: [briefingWorkflow],
      alwaysReplay: true,
    });
    ingress = clients.connect({ url: env.baseUrl() });
  }, TIMEOUT);

  afterAll(async () => {
    await env?.stop();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }, TIMEOUT);

  const etdSoon = () => new Date(Date.now() + 30 * 60 * 1000).toISOString(); // < 1h away -> no timer
  const requestFor = (etdIso: string) => ({
    departure: "KMCO", destination: "KJAX", alternate: "KDAB",
    etdIso, flightRules: "VFR" as const, aircraft: "PA-28",
  });

  async function pollPhase(id: string, phase: string): Promise<BriefingStatus> {
    const client = ingress.workflowClient(briefingWorkflow, id);
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = (await client.getStatus()) as BriefingStatus;
      if (status.phase === phase) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`workflow ${id} never reached phase ${phase}`);
  }

  it("happy path: brief -> suspend at ack -> re-brief unchanged -> complete", { timeout: TIMEOUT }, async () => {
    rebriefChanged = false;
    const before = { ...hits };
    const client = ingress.workflowClient(briefingWorkflow, "e2e-happy");
    const submission = await client.workflowSubmit(requestFor(etdSoon()));

    // Suspends at the durable promise with the briefing stored.
    const atAck = await pollPhase("e2e-happy", "AWAITING_ACK");
    expect(atAck.briefing?.recommendation).toBe("GO_WITH_CAUTION");
    expect(atAck.rebrief).toBeNull();

    await client.ack();
    const result = await ingress.result(submission);
    expect(result).toBe("UNCHANGED_CONFIRMED");

    const final = await pollPhase("e2e-happy", "UNCHANGED_CONFIRMED");
    expect(final.rebrief?.changed).toBe(false);

    // The journaled-side-effect proof: despite alwaysReplay forcing a full
    // journal replay at every suspension, each fetch ran exactly twice
    // (initial + re-brief), and Claude was called exactly twice.
    expect((hits["/api/data/metar"] ?? 0) - (before["/api/data/metar"] ?? 0)).toBe(2);
    expect((hits["/api/data/taf"] ?? 0) - (before["/api/data/taf"] ?? 0)).toBe(2);
    expect((hits["/anthropic/v1/messages"] ?? 0) - (before["/anthropic/v1/messages"] ?? 0)).toBe(2);
  });

  it("material change path requires a second acknowledgment", { timeout: TIMEOUT }, async () => {
    rebriefChanged = true;
    const client = ingress.workflowClient(briefingWorkflow, "e2e-changed");
    const submission = await client.workflowSubmit(requestFor(etdSoon()));

    await pollPhase("e2e-changed", "AWAITING_ACK");
    await client.ack();

    // Change detected -> workflow suspends again waiting for re-ack.
    const atReack = await pollPhase("e2e-changed", "AWAITING_REACK");
    expect(atReack.rebrief?.changed).toBe(true);
    expect(atReack.rebrief?.recommendation).toBe("NO_GO");

    await client.reAck();
    expect(await ingress.result(submission)).toBe("RE_ACKNOWLEDGED");
  });

  it("durable timer: ETD just over an hour out delays the re-brief", { timeout: TIMEOUT }, async () => {
    rebriefChanged = false;
    // ETD - 1h is ~8s in the future -> the workflow must sleep before re-briefing.
    const etd = new Date(Date.now() + 60 * 60 * 1000 + 8000).toISOString();
    const client = ingress.workflowClient(briefingWorkflow, "e2e-timer");
    const submission = await client.workflowSubmit(requestFor(etd));

    await pollPhase("e2e-timer", "AWAITING_ACK");
    const ackedAt = Date.now();
    await client.ack();

    expect(await ingress.result(submission)).toBe("UNCHANGED_CONFIRMED");
    // Completion had to wait for the durable timer to fire.
    expect(Date.now() - ackedAt).toBeGreaterThanOrEqual(5000);
  });

  it("invalid input fails terminally (no retries)", { timeout: TIMEOUT }, async () => {
    const client = ingress.workflowClient(briefingWorkflow, "e2e-invalid");
    const submission = await client.workflowSubmit({
      departure: "not-an-icao", destination: "KJAX",
      etdIso: etdSoon(), flightRules: "VFR",
    } as never);
    await expect(ingress.result(submission)).rejects.toThrow(/Invalid briefing request/);
  });

  it("past ETD is rejected as terminal", { timeout: TIMEOUT }, async () => {
    const client = ingress.workflowClient(briefingWorkflow, "e2e-past-etd");
    const submission = await client.workflowSubmit(
      requestFor(new Date(Date.now() - 60_000).toISOString()),
    );
    await expect(ingress.result(submission)).rejects.toThrow(/future/);
  });
});

import * as restate from "@restatedev/restate-sdk";
import { briefingWorkflow } from "./workflow.js";

// Load .env if present (native in Node 21.7+ — no dotenv dependency).
// Real env vars take precedence; missing file is fine.
try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on exported shell vars */
}

// Serves the workflow over HTTP/2 on :9080. Register it with the Restate
// server once it's running:  restate -y deployments register localhost:9080 --force
restate.serve({ services: [briefingWorkflow], port: 9080 });

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Tiny static server for the pilot UI. Serves ui/index.html and proxies
// /restate/* to the Restate ingress so the page never deals with CORS.
try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on exported shell vars */
}
const RESTATE_URL = process.env.RESTATE_URL ?? "http://localhost:8080";
const PORT = Number(process.env.UI_PORT ?? 3000);
const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(htmlPath));
      return;
    }
    // Forward only clean ingress paths — no traversal tricks.
    if (req.url?.startsWith("/restate/") && !req.url.includes("..")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`${RESTATE_URL}${req.url}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: body.length > 0 ? body : undefined,
      });
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(await upstream.text());
      return;
    }
    res.writeHead(404).end("not found");
  } catch (error) {
    console.error("ui proxy error:", error);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream unavailable — is the Restate server running?" }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Pilot UI on http://localhost:${PORT} (proxying to ${RESTATE_URL})`);
});

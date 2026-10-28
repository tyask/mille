import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql, seedSql } from "../db/sql";

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("Request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startMemoryDatabase(options: { token?: string; port?: number } = {}) {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid local database token");
  const database = new PGlite();
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      try {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        }
      } finally {
        if (!database.closed) await database.close();
      }
    })();
    return closePromise;
  }
  try {
    const configuration = { mode: "memory" as const, url: "http://127.0.0.1/", token,
      environment: "development" as const, environmentId: "local-memory" as const };
    await database.exec(migrationSql(configuration, true));
    await database.exec(seedSql(configuration));
    server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (request.url !== "/query" || request.method !== "POST"
        || request.headers.authorization !== `Bearer ${token}`
        || !request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(403).end(JSON.stringify({ error: "Forbidden" })); return;
      }
      try {
        const body = await readBody(request) as { text?: unknown; parameters?: unknown };
        if (typeof body.text !== "string" || !Array.isArray(body.parameters)) throw new Error("Invalid query");
        const result = await database.query(body.text, body.parameters);
        response.end(JSON.stringify({ rows: result.rows }));
      } catch { response.writeHead(400).end(JSON.stringify({ error: "Local database query failed" })); }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(options.port ?? 0, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local database did not start");
    return { url: `http://127.0.0.1:${address.port}`, token, database, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = process.env.MILLE_MEMORY_DATABASE_TOKEN;
  if (!token) throw new Error("MILLE_MEMORY_DATABASE_TOKEN must be supplied by the local launcher");
  startMemoryDatabase({ token }).then(instance => {
    console.log(JSON.stringify({ ready: true, url: instance.url }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void instance.close(); });
  }).catch(() => { console.error("Local database startup failed"); process.exitCode = 1; });
}

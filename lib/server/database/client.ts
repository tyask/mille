import { neon } from "@neondatabase/serverless";
import { databaseConfiguration, type DatabaseConfiguration } from "./environment";

export type DatabaseRow = Record<string, unknown>;
export type Query = <Row extends DatabaseRow = DatabaseRow>(text: string, parameters?: unknown[]) => Promise<Row[]>;
export type EnvironmentMarker = { project: string; environment: string; environment_id: string };

export function createQuery(configuration: DatabaseConfiguration): Query {
  if (configuration.mode === "memory") {
    return async <Row extends DatabaseRow>(text: string, parameters: unknown[] = []): Promise<Row[]> => {
      const response = await fetch(`${configuration.url}/query`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${configuration.token}` },
        body: JSON.stringify({ text, parameters }), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("ローカルデータベースへの問い合わせに失敗しました。");
      const result = await response.json() as { rows: Row[] };
      return result.rows;
    };
  }
  const connection = neon(configuration.url);
  return async <Row extends DatabaseRow>(text: string, parameters: unknown[] = []): Promise<Row[]> => {
    return await connection.query(text, parameters) as Row[];
  };
}

export async function verifyDatabaseOwnership(query: Query, configuration: DatabaseConfiguration): Promise<void> {
  let rows: DatabaseRow[];
  try { rows = await query("SELECT project, environment, environment_id FROM mille_environment WHERE singleton = true"); }
  catch { throw new Error("Mille 専用データベースの環境識別を確認できません。"); }
  if (rows.length !== 1 || rows[0].project !== "tyask/mille" || rows[0].environment !== configuration.environment
    || rows[0].environment_id !== configuration.environmentId) {
    throw new Error("Mille 専用データベースの環境識別が一致しません。");
  }
}

export async function verifiedDatabaseQuery(): Promise<{ query: Query; configuration: DatabaseConfiguration }> {
  const configuration = databaseConfiguration();
  const query = createQuery(configuration);
  await verifyDatabaseOwnership(query, configuration);
  return { query, configuration };
}

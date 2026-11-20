import { createQuery, verifyDatabaseOwnership } from "../../lib/server/database/client";
import { hostedDatabaseConfiguration } from "../../lib/server/database/environment";
import { migrationSql, seedSql } from "../db/sql";

export function previewDatabaseEnvironmentId(pr: number): string {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("PR 番号が無効です。");
  return `mille-pr-${pr}`;
}

/** Call only after the provider's project, branch, database and direct endpoint are verified. */
export async function preparePreviewDatabase(input: {
  pr: number;
  connectionString: string;
  expectedHost: string;
  expectedDatabase: string;
  initialize: boolean;
}): Promise<void> {
  const configuration = hostedDatabaseConfiguration(
    "preview", input.expectedHost, previewDatabaseEnvironmentId(input.pr),
    { MILLE_PREVIEW_DATABASE_URL: input.connectionString },
  );
  const url = new URL(configuration.url);
  if (url.pathname !== `/${encodeURIComponent(input.expectedDatabase)}`
    || configuration.host.includes("-pooler.") || url.searchParams.get("sslmode") !== "require") {
    throw new Error("Preview DB の名前または直接接続設定が一致しません。");
  }

  const query = createQuery(configuration);
  if (!input.initialize) await verifyDatabaseOwnership(query, configuration);
  await query(migrationSql(configuration, input.initialize));
  await verifyDatabaseOwnership(query, configuration);
  await query(seedSql(configuration));
}

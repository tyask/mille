import { createQuery, verifyDatabaseOwnership } from "../../lib/server/database/client";
import { hostedDatabaseConfiguration } from "../../lib/server/database/environment";
import { migrationFileName, migrationSql, repositoryMigrationSources, seedSql, type MigrationSource } from "../db/sql";

const migrationDirectory = "db/migrations/";

export function migrationSourcesFromFiles(files: readonly { file: string; data: Buffer }[]): MigrationSource[] {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const entries = files.filter(({ file }) => file.startsWith(migrationDirectory) && /\.sql$/i.test(file));
  return entries.map(({ file, data }) => {
    const name = file.slice(migrationDirectory.length);
    if (!migrationFileName.test(name)) throw new Error("PR の migration ファイル名が無効です。");
    let source: string;
    try { source = decoder.decode(data); }
    catch { throw new Error("PR の migration は UTF-8 の SQL が必要です。"); }
    if (!source.trim() || source.includes("\0")) throw new Error("PR の migration 本文が無効です。");
    return { name, source };
  }).sort((left, right) => Number(left.name.slice(0, 3)) - Number(right.name.slice(0, 3)));
}

export function previewMigrationSources(files: readonly { file: string; data: Buffer }[]): MigrationSource[] {
  const sources = migrationSourcesFromFiles(files);
  const trusted = repositoryMigrationSources();
  if (!trusted.length
    || trusted.some(({ name, source }, index) => sources[index]?.name !== name || sources[index].source !== source)) {
    throw new Error("PR の migration に main の原本と一致しない履歴があります。");
  }
  for (let index = trusted.length; index < sources.length; index++) {
    const current = Number(sources[index].name.slice(0, 3));
    const previous = Number(sources[index - 1].name.slice(0, 3));
    if (current !== previous + 1) throw new Error("PR の migration は次の連番から追加してください。");
  }
  return sources;
}

export function previewDatabaseEnvironmentId(pr: number): string {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("PR 番号が無効です。");
  return `mille-pr-${pr}`;
}

/** Call only after the provider's project, branch, database and direct endpoint are verified. */
export async function preparePreviewDatabase(input: {
  pr: number;
  environmentId?: string;
  connectionString: string;
  expectedHost: string;
  expectedDatabase: string;
  initialize: boolean;
  migrations?: readonly MigrationSource[];
}): Promise<void> {
  const legacyEnvironmentId = previewDatabaseEnvironmentId(input.pr);
  const configuration = hostedDatabaseConfiguration(
    "preview", input.expectedHost, input.environmentId ?? legacyEnvironmentId,
    { MILLE_PREVIEW_DATABASE_URL: input.connectionString },
  );
  const url = new URL(configuration.url);
  if (url.pathname !== `/${encodeURIComponent(input.expectedDatabase)}`
    || configuration.host.includes("-pooler.") || url.searchParams.get("sslmode") !== "require") {
    throw new Error("Preview DB の名前または直接接続設定が一致しません。");
  }

  const query = createQuery(configuration);
  if (!input.initialize) await verifyDatabaseOwnership(query, configuration);
  await query(migrationSql(configuration, input.initialize, input.migrations));
  await verifyDatabaseOwnership(query, configuration);
  await query(seedSql(configuration));
}

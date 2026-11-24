import { createHash } from "node:crypto";
import { z } from "zod";
import { createQuery, verifyDatabaseOwnership, type DatabaseRow, type Query } from "../../lib/server/database/client";
import { hostedDatabaseConfiguration, type DatabaseConfiguration } from "../../lib/server/database/environment";
import { migrateDatabase } from "../db/migrate";
import { migrationFileName, migrationSql, ownershipGuard, proceduralBlock, sqlLiteral, type MigrationSource } from "../db/sql";
import {
  matchesNeonPreviewConnection, neonPreviewBranchDetails, neonPreviewBranchEndpoints,
  neonPreviewConnectionQuery, neonPreviewConnectionUri,
} from "./neon";

const projectId = "billowing-cherry-59956184";
const branchId = "br-dark-rain-a1cc9tfa";
const endpointId = "ep-bitter-wind-a1atj6vn";
const host = `${endpointId}.ap-southeast-1.aws.neon.tech`;
const database = "neondb";
const role = "neondb_owner";
const environmentId = "mille-preview";
const projectPath = `/projects/${projectId}`;
const branchPath = `${projectPath}/branches/${branchId}`;
const migrationBaseline = [
  ["001_auth.sql", "83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126"],
  ["002_workspaces.sql", "8ea6f940c097035d2c0e54417b60473b449219702f3aa232c24969c522c12eba"],
  ["003_meals.sql", "6a00446fca1293f006ac71df6fa71f3a7b81c31e3009268c9811b5ed674473d4"],
  ["004_meal_api.sql", "b3992b6880d6d5bc86636fdf88d44dccd249dff431df471500742ebaec8eec2b"],
  ["005_meal_plans.sql", "afc13b2cb48c9e3e37e0c73cae90a0ac7a3c086829e7bd502bce163f8d5cb71a"],
  ["006_meal_suggestions.sql", "210f984f9444211a81c2c82f120c38c3c9353b0ed7aceb42f5534a2be82cc857"],
] as const;

const projectDetails = z.object({ project: z.object({ id: z.literal(projectId), name: z.literal(environmentId),
  org_id: z.literal("org-twilight-grass-67941976") }) });
const databaseDetails = z.object({ databases: z.tuple([z.object({ id: z.literal(42166654), branch_id: z.literal(branchId), name: z.literal(database),
  owner_name: z.literal(role) })]) });
const migrationHistory = z.array(z.object({ name: z.string(), sha256: z.string(), applied_at: z.string().min(1) }));
type MigrationHistory = z.infer<typeof migrationHistory>;
type CheckedMigration = MigrationSource & { sha256: string };

export type StandingDatabaseIdentity = { projectId: string; branchId: string; endpointId: string; host: string };
export const standingDatabaseResourceSchema = z.strictObject({ projectId: z.literal(projectId), branchId: z.literal(branchId),
  endpointId: z.literal(endpointId) });
type StandingDatabaseOptions = { request?: typeof fetch; query?: Query; previousSources?: readonly MigrationSource[] };

async function readNeon<T>(apiKey: string, path: string, schema: z.ZodType<T>, request: typeof fetch): Promise<T> {
  try {
    if (!apiKey) throw new Error();
    const response = await request(new URL(`https://console.neon.tech/api/v2${path}`), {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error();
    return schema.parse(await response.json());
  } catch {
    throw new Error("Neon の常設 Preview 情報を確認できません。");
  }
}

export async function identifyStandingDatabase(apiKey: string, request: typeof fetch = fetch): Promise<StandingDatabaseIdentity> {
  const [, { branch }, { endpoints }] = await Promise.all([
    readNeon(apiKey, projectPath, projectDetails, request),
    readNeon(apiKey, branchPath, neonPreviewBranchDetails, request),
    readNeon(apiKey, `${branchPath}/endpoints`, neonPreviewBranchEndpoints, request),
    readNeon(apiKey, `${branchPath}/databases`, databaseDetails, request),
  ]);
  if (branch.id !== branchId || branch.project_id !== projectId || branch.name !== "main" || !branch.default
    || branch.parent_id != null || branch.current_state !== "ready" || branch.pending_state != null) {
    throw new Error("Neon の常設 Preview ブランチが一致しません。");
  }
  const writable = endpoints.filter(item => item.type === "read_write");
  const [endpoint] = writable;
  if (endpoints.some(item => item.project_id !== projectId || item.branch_id !== branchId)
    || writable.length !== 1 || endpoint.id !== endpointId || endpoint.disabled
    || endpoint.host !== host) {
    throw new Error("Neon の常設 Preview エンドポイントが一致しません。");
  }
  return { projectId, branchId, endpointId, host: endpoint.host };
}

function sameStandingDatabase(left: StandingDatabaseIdentity, right: StandingDatabaseIdentity): boolean {
  return left.projectId === right.projectId && left.branchId === right.branchId
    && left.endpointId === right.endpointId && left.host === right.host;
}

function checkSources(sources: readonly MigrationSource[]): CheckedMigration[] {
  const migrations = sources.map(({ name, source }) => ({ name, source, sha256: createHash("sha256").update(source).digest("hex") }));
  if (migrations.length < migrationBaseline.length || migrations.some(({ name }, index) =>
    !migrationFileName.test(name) || Number(name.slice(0, 3)) !== index + 1)
    || migrationBaseline.some(([name, sha256], index) => migrations[index].name !== name || migrations[index].sha256 !== sha256)) {
    throw new Error("常設 Preview の移行 SQL が一致しません。");
  }
  return migrations;
}

function requiredHistoryLength(migrations: readonly CheckedMigration[], previousSources: readonly MigrationSource[] | undefined) {
  if (previousSources === undefined) return 2;
  if (previousSources.length < 2 || previousSources.length > migrations.length
    || migrations.slice(0, previousSources.length).some(({ name, source }, index) =>
      name !== previousSources[index]?.name || source !== previousSources[index]?.source)) {
    throw new Error("従来の常設 Preview と移行 SQL が一致しません。");
  }
  return previousSources.length;
}

async function readHistory(query: Query, migrations: readonly CheckedMigration[], minimumLength: number) {
  const history = migrationHistory.parse(await query("SELECT name, sha256, applied_at::text FROM public.schema_migrations ORDER BY name"));
  if (history.length < minimumLength || history.length > migrations.length || history.some(({ name, sha256 }, index) =>
    name !== migrations[index].name || sha256 !== migrations[index].sha256)) {
    throw new Error("常設 Preview の移行履歴が一致しません。");
  }
  return history;
}

function requirePreservedHistory(before: MigrationHistory, after: MigrationHistory) {
  if (after.length < before.length || before.some(({ applied_at }, index) => applied_at !== after[index].applied_at)) {
    throw new Error("常設 Preview の適用済み移行履歴が変わりました。");
  }
}

function migrationWithBaseline(query: Query, configuration: DatabaseConfiguration, migrations: readonly CheckedMigration[],
  before: MigrationHistory): Query {
  let started = false;
  const approvedSql = migrationSql(configuration, false, migrations);
  const checkedRows = before.map(({ name, sha256, applied_at }) =>
    `(${sqlLiteral(name)}, ${sqlLiteral(sha256)}, ${sqlLiteral(applied_at)}::timestamptz)`).join(",\n      ");
  const changedAppliedHistory = `EXISTS (SELECT 1 FROM (VALUES
      ${checkedRows}
    ) AS expected(name, sha256, applied_at)
      WHERE NOT EXISTS (SELECT 1 FROM public.schema_migrations AS actual
        WHERE actual.name = expected.name AND actual.sha256 = expected.sha256 AND actual.applied_at = expected.applied_at))`;
  const releaseRows = migrations.map(({ name, sha256 }) =>
    `(${sqlLiteral(name)}, ${sqlLiteral(sha256)})`).join(",\n      ");
  // Check the applied ledger on both sides of the migration while holding the transaction lock.
  const guardedSql = proceduralBlock("mille_standing_preview", `BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('mille:schema'));
  LOCK TABLE public.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) FROM public.schema_migrations) <> ${before.length} OR ${changedAppliedHistory} THEN
    RAISE EXCEPTION 'Mille standing migration baseline mismatch';
  END IF;
  EXECUTE ${sqlLiteral(approvedSql)};
  ${ownershipGuard(configuration)}
  IF (SELECT count(*) FROM public.schema_migrations) <> ${migrations.length} OR ${changedAppliedHistory}
    OR EXISTS (SELECT 1 FROM (VALUES
      ${releaseRows}
    ) AS expected(name, sha256)
      WHERE NOT EXISTS (SELECT 1 FROM public.schema_migrations AS actual
        WHERE actual.name = expected.name AND actual.sha256 = expected.sha256)) THEN
    RAISE EXCEPTION 'Mille standing migration result mismatch';
  END IF;
END;`);
  return async <Row extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<Row[]> => {
    if (started) return query<Row>(sql, parameters);
    if (sql !== approvedSql || parameters?.length) throw new Error("常設 Preview の承認済み移行と一致しません。");
    started = true;
    return query<Row>(guardedSql);
  };
}

export async function openStandingDatabase(
  apiKey: string, expected: StandingDatabaseIdentity, sources: readonly MigrationSource[],
  { request = fetch, query: testQuery, previousSources }: StandingDatabaseOptions = {},
) {
  let stage = "承認済み SQL の照合";
  try {
    const migrations = checkSources(sources);
    const minimumHistoryLength = requiredHistoryLength(migrations, previousSources);
    stage = "Neon の常設接続先の照合";
    const verifyIdentity = async () => {
      if (!sameStandingDatabase(expected, await identifyStandingDatabase(apiKey, request))) throw new Error();
    };
    await verifyIdentity();
    const params = neonPreviewConnectionQuery(branchId, endpointId, database, role);
    const { uri } = await readNeon(apiKey, `${projectPath}/connection_uri?${params}`, neonPreviewConnectionUri, request);
    const connection = new URL(uri);
    const channelBinding = connection.searchParams.getAll("channel_binding");
    if (!matchesNeonPreviewConnection(connection, expected.host, database, role)
      || [...connection.searchParams.keys()].some(key => key !== "sslmode" && key !== "channel_binding")
      || (channelBinding.length > 0 && channelBinding.join() !== "require")
      || /[\u0000-\u001f\u007f]/.test(decodeURIComponent(connection.password))) throw new Error();
    const configuration = hostedDatabaseConfiguration("preview", expected.host, environmentId, { MILLE_PREVIEW_DATABASE_URL: uri });
    const query = testQuery ?? createQuery(configuration);

    stage = "既存 DB の所有と移行履歴の照合";
    const readOwnedHistory = async () => {
      await verifyDatabaseOwnership(query, configuration);
      return readHistory(query, migrations, minimumHistoryLength);
    };
    let observed = await readOwnedHistory();
    const refresh = async () => {
      await verifyIdentity();
      const current = await readOwnedHistory();
      requirePreservedHistory(observed, current);
      return current;
    };
    const verifyComplete = async () => {
      const current = await refresh();
      if (current.length !== migrations.length) throw new Error("常設 Preview の移行履歴が不足しています。");
      return current;
    };

    return {
      configuration,
      async migrate(verifyCurrent: () => Promise<void>): Promise<string[]> {
        let phase = "移行前の実行元と接続先の再照合";
        try {
          const before = await refresh();
          const pending = migrations.slice(before.length);
          if (!pending.length) {
            await verifyCurrent();
            observed = before;
            return [];
          }
          const guardedQuery = migrationWithBaseline(query, configuration, migrations, before);
          await verifyCurrent();
          phase = "承認済み移行の適用";
          await migrateDatabase(configuration, { query: guardedQuery, sources: migrations });
          phase = "移行後の所有と移行履歴の照合";
          const after = await verifyComplete();
          requirePreservedHistory(before, after);
          await verifyCurrent();
          observed = after;
          return pending.map(({ name }) => name);
        } catch {
          throw new Error(`常設 Preview DB は「${phase}」で停止しました。`);
        }
      },
      async verify(): Promise<void> {
        try {
          observed = await verifyComplete();
        } catch {
          throw new Error("常設 Preview DB の所有と移行履歴を再照合できません。");
        }
      },
    };
  } catch {
    throw new Error(`常設 Preview DB は「${stage}」で停止しました。`);
  }
}

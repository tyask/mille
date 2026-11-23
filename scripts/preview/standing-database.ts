import { createHash } from "node:crypto";
import { z } from "zod";
import { createQuery, verifyDatabaseOwnership, type DatabaseRow, type Query } from "../../lib/server/database/client";
import { hostedDatabaseConfiguration } from "../../lib/server/database/environment";
import { migrateDatabase } from "../db/migrate";
import { migrationSql, repositoryMigrationSources, sqlLiteral } from "../db/sql";
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
const allowedMigrations = [
  ["001_auth.sql", "83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126"],
  ["002_workspaces.sql", "8ea6f940c097035d2c0e54417b60473b449219702f3aa232c24969c522c12eba"],
  ["003_meals.sql", "6a00446fca1293f006ac71df6fa71f3a7b81c31e3009268c9811b5ed674473d4"],
  ["004_meal_api.sql", "b3992b6880d6d5bc86636fdf88d44dccd249dff431df471500742ebaec8eec2b"],
] as const;

const projectDetails = z.object({ project: z.object({ id: z.literal(projectId), name: z.literal(environmentId),
  org_id: z.literal("org-twilight-grass-67941976") }) });
const databaseDetails = z.object({ databases: z.tuple([z.object({ id: z.literal(42166654), branch_id: z.literal(branchId), name: z.literal(database),
  owner_name: z.literal(role) })]) });
const migrationHistory = z.array(z.object({ name: z.string(), sha256: z.string(), applied_at: z.string().min(1) }));

export type StandingDatabaseIdentity = { projectId: string; branchId: string; endpointId: string; host: string };
export const standingDatabaseResourceSchema = z.strictObject({ projectId: z.literal(projectId), branchId: z.literal(branchId),
  endpointId: z.literal(endpointId) });
type StandingDatabaseOptions = { request?: typeof fetch; query?: Query; verifyCurrent?: () => Promise<void>; allowInitialMigrations?: boolean };

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

async function readHistory(query: Query) {
  const history = migrationHistory.parse(await query("SELECT name, sha256, applied_at::text FROM public.schema_migrations ORDER BY name"));
  if (history.length < 2 || history.length > allowedMigrations.length || history.some(({ name, sha256 }, index) =>
    name !== allowedMigrations[index][0] || sha256 !== allowedMigrations[index][1])) {
    throw new Error("常設 Preview の移行履歴が一致しません。");
  }
  return history;
}

function migrationWithBaseline(query: Query, approvedSql: string): Query {
  let started = false;
  return async <Row extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<Row[]> => {
    if (started) return query<Row>(sql, parameters);
    if (sql !== approvedSql || parameters?.length) throw new Error("常設 Preview の承認済み移行と一致しません。");
    started = true;
    // Hold the existing migration lock across the baseline guard and the migration itself.
    // A concurrent change cannot cause the runner to treat a missing 002 as pending.
    return query<Row>(`DO $mille_standing_preview$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('mille:schema'));
  LOCK TABLE public.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE name = ${sqlLiteral(allowedMigrations[0][0])}
      AND sha256 = ${sqlLiteral(allowedMigrations[0][1])})
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE name = ${sqlLiteral(allowedMigrations[1][0])}
      AND sha256 = ${sqlLiteral(allowedMigrations[1][1])}) THEN
    RAISE EXCEPTION 'Mille standing migration baseline mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE name = ${sqlLiteral(allowedMigrations[3][0])})
    AND NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE name = ${sqlLiteral(allowedMigrations[2][0])}) THEN
    RAISE EXCEPTION 'Mille standing migration order mismatch';
  END IF;
  EXECUTE ${sqlLiteral(approvedSql)};
END;
$mille_standing_preview$;`);
  };
}

export async function prepareStandingDatabase(
  apiKey: string, expected: StandingDatabaseIdentity,
  { request = fetch, query: testQuery, verifyCurrent, allowInitialMigrations = true }: StandingDatabaseOptions = {},
) {
  let stage = "承認済み SQL の照合";
  try {
    const sources = repositoryMigrationSources();
    if (sources.length !== allowedMigrations.length || sources.some(({ name, source }, index) =>
      name !== allowedMigrations[index][0] || createHash("sha256").update(source).digest("hex") !== allowedMigrations[index][1])) {
      throw new Error();
    }
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
    await verifyDatabaseOwnership(query, configuration);
    const before = await readHistory(query);
    if (!allowInitialMigrations && before.length !== allowedMigrations.length) throw new Error();
    stage = "移行前の実行元と接続先の再照合";
    await verifyIdentity();
    await verifyCurrent?.();
    if (before.length < allowedMigrations.length) {
      stage = "承認済み移行の適用";
      const sql = migrationSql(configuration, false, sources);
      await migrateDatabase(configuration, { initialize: false, query: migrationWithBaseline(query, sql) });
    }
    stage = "移行後の所有と移行履歴の照合";
    await verifyDatabaseOwnership(query, configuration);
    const after = await readHistory(query);
    if (after.length !== allowedMigrations.length || before.some(({ applied_at }, index) => applied_at !== after[index].applied_at)) {
      throw new Error();
    }
    stage = "移行後の実行元と接続先の再照合";
    await verifyIdentity();
    await verifyCurrent?.();
    return configuration;
  } catch {
    throw new Error(`常設 Preview DB は「${stage}」で停止しました。`);
  }
}

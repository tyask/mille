import { createQuery, verifyDatabaseOwnership, type Query } from "../../lib/server/database/client";
import type { DatabaseConfiguration } from "../../lib/server/database/environment";
import { migrationSql, type MigrationSource } from "./sql";

export async function migrateDatabase(
  configuration: DatabaseConfiguration,
  { initialize = false, query = createQuery(configuration), sources }: {
    initialize?: boolean;
    query?: Query;
    sources?: readonly MigrationSource[];
  } = {},
): Promise<void> {
  await query(migrationSql(configuration, initialize, sources));
  await verifyDatabaseOwnership(query, configuration);
}

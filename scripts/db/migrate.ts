import { createQuery, verifyDatabaseOwnership, type Query } from "../../lib/server/database/client";
import type { DatabaseConfiguration } from "../../lib/server/database/environment";
import { migrationSql } from "./sql";

export async function migrateDatabase(
  configuration: DatabaseConfiguration,
  { initialize = false, query = createQuery(configuration) }: { initialize?: boolean; query?: Query } = {},
): Promise<void> {
  await query(migrationSql(configuration, initialize));
  await verifyDatabaseOwnership(query, configuration);
}

import { writeFileSync } from "node:fs";
import type { DatabaseConfiguration } from "../../lib/server/database/environment";
import { migrationSql, seedSql } from "./sql";

for (const environment of ["preview", "production"] as const) {
  // SQL contains no connection URL or credential. Operators verify the selected project/database/host separately.
  const configuration: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment,
    environmentId: `mille-${environment}` };
  writeFileSync(new URL(`initialize-${environment}.sql`, import.meta.url), migrationSql(configuration, true));
  if (environment === "preview") writeFileSync(new URL("seed-preview.sql", import.meta.url), seedSql(configuration));
}

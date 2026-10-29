import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseConfiguration } from "../../lib/server/database/environment";
import { TEST_USERS } from "../../lib/shared/test-users";

export function sqlLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** PostgreSQL scans a dollar-quoted body before parsing its inner string literals. */
function proceduralBlock(label: string, body: string): string {
  let suffix = 0;
  let delimiter = `$${label}$`;
  while (body.includes(delimiter)) delimiter = `$${label}_${++suffix}$`;
  return `DO ${delimiter} ${body} ${delimiter};`;
}

export function ownershipGuard(configuration: DatabaseConfiguration): string {
  return `IF NOT EXISTS (SELECT 1 FROM public.mille_environment WHERE singleton = true
    AND project = 'tyask/mille' AND environment = ${sqlLiteral(configuration.environment)}
    AND environment_id = ${sqlLiteral(configuration.environmentId)}) THEN
      RAISE EXCEPTION 'Mille database environment mismatch';
    END IF;`;
}

export function migrationSql(configuration: DatabaseConfiguration, initialize = false): string {
  const directory = new URL("../../db/migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort().map(name => {
    const source = readFileSync(new URL(name, directory), "utf8");
    return { name, source, checksum: createHash("sha256").update(source).digest("hex") };
  });
  const first = migrations[0];
  if (first?.name !== "001_auth.sql" || new Set(migrations.map(migration => migration.name.slice(0, 3))).size !== migrations.length) {
    throw new Error("Migration sequence is invalid");
  }
  return `-- Mille schema. Verify the dedicated project, database and expected host before executing.
${proceduralBlock("mille_migration", `BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
  IF to_regclass('public.mille_environment') IS NULL THEN
    IF NOT ${initialize ? "true" : "false"} THEN RAISE EXCEPTION 'Explicit empty-database initialization is required'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r','p','v','m','S','f')) THEN
      RAISE EXCEPTION 'Mille initialization requires an empty dedicated database';
    END IF;
    EXECUTE ${sqlLiteral(first.source)};
    INSERT INTO mille_environment (singleton,project,environment,environment_id)
      VALUES (true,'tyask/mille',${sqlLiteral(configuration.environment)},${sqlLiteral(configuration.environmentId)});
    CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations (name,sha256) VALUES ('001_auth.sql',${sqlLiteral(first.checksum)});
  ELSE
    ${ownershipGuard(configuration)}
    IF to_regclass('public.schema_migrations') IS NULL OR NOT EXISTS
      (SELECT 1 FROM schema_migrations WHERE name = '001_auth.sql' AND sha256 = ${sqlLiteral(first.checksum)}) THEN
      RAISE EXCEPTION 'Mille migration history or checksum mismatch';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name NOT IN (${migrations.map(migration => sqlLiteral(migration.name)).join(", ")})) THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
${migrations.map(migration => `  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${sqlLiteral(migration.name)} AND sha256 <> ${sqlLiteral(migration.checksum)}) THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;`).join("\n")}
${migrations.slice(1).map(migration => `  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${sqlLiteral(migration.name)}) THEN
    EXECUTE ${sqlLiteral(migration.source)};
    INSERT INTO schema_migrations (name,sha256) VALUES (${sqlLiteral(migration.name)},${sqlLiteral(migration.checksum)});
  END IF;`).join("\n")}
END;`)}\n`;
}

export function seedSql(configuration: DatabaseConfiguration): string {
  if (configuration.environment === "production") throw new Error("Production へテスト利用者を登録できません。");
  return `-- Only synthetic preview/local users. Existing records are never re-enabled or overwritten.
DO $mille_seed$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
  ${ownershipGuard(configuration)}
  LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE;
${TEST_USERS.map(user => `
  IF EXISTS (SELECT 1 FROM app_users WHERE
    (id = ${sqlLiteral(user.id)} AND (email <> ${sqlLiteral(user.email)} OR NOT is_test))
    OR (email = ${sqlLiteral(user.email)} AND id <> ${sqlLiteral(user.id)})) THEN
    RAISE EXCEPTION 'Mille test user identity mismatch';
  END IF;
  INSERT INTO app_users (id,email,name,is_enabled,is_test)
    VALUES (${sqlLiteral(user.id)},${sqlLiteral(user.email)},${sqlLiteral(user.name)},true,true)
    ON CONFLICT (id) DO NOTHING;`).join("\n")}
END; $mille_seed$;\n`;
}

export function registerUserSql(configuration: DatabaseConfiguration, id: string, email: string, name: string): string {
  if (email.endsWith("@mille.invalid") || id.startsWith("mille-test-user-")) throw new Error("予約済みのテストIDは登録できません。");
  return proceduralBlock("mille_register", `BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
    ${ownershipGuard(configuration)}
    INSERT INTO app_users (id,email,name,is_enabled,is_test)
      VALUES (${sqlLiteral(id)},${sqlLiteral(email)},${sqlLiteral(name)},true,false);
  END;`);
}

export function disableUserSql(configuration: DatabaseConfiguration, id: string): string {
  return proceduralBlock("mille_disable", `BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
    ${ownershipGuard(configuration)}
    IF NOT EXISTS (SELECT 1 FROM app_users WHERE id = ${sqlLiteral(id)}) THEN
      RAISE EXCEPTION 'Mille user does not exist';
    END IF;
    UPDATE app_users SET is_enabled = false,updated_at = now() WHERE id = ${sqlLiteral(id)};
  END;`);
}

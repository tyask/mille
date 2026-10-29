-- Mille auth schema. Verify the dedicated project, database and expected host before executing.
DO $mille_migration$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
  IF to_regclass('public.mille_environment') IS NULL THEN
    IF NOT true THEN RAISE EXCEPTION 'Explicit empty-database initialization is required'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r','p','v','m','S','f')) THEN
      RAISE EXCEPTION 'Mille initialization requires an empty dedicated database';
    END IF;
    CREATE TABLE mille_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project text NOT NULL CHECK (project = 'tyask/mille'),
  environment text NOT NULL CHECK (environment IN ('development', 'preview', 'production')),
  environment_id text NOT NULL CHECK (char_length(environment_id) BETWEEN 1 AND 120)
);

CREATE TABLE app_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  image_url text,
  is_enabled boolean NOT NULL DEFAULT false,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION mille_reject_production_test_user() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mille_environment WHERE environment = 'production')
    AND (NEW.is_test OR NEW.id LIKE 'mille-test-user-%' OR NEW.email LIKE '%@mille.invalid') THEN
    RAISE EXCEPTION 'Production does not permit test users';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mille_production_test_user_guard
BEFORE INSERT OR UPDATE ON app_users
FOR EACH ROW EXECUTE FUNCTION mille_reject_production_test_user();

    INSERT INTO mille_environment (singleton,project,environment,environment_id)
      VALUES (true,'tyask/mille','production','mille-production');
    CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations (name,sha256) VALUES ('001_auth.sql','83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.mille_environment WHERE singleton = true
    AND project = 'tyask/mille' AND environment = 'production'
    AND environment_id = 'mille-production') THEN
      RAISE EXCEPTION 'Mille database environment mismatch';
    END IF;
    IF to_regclass('public.schema_migrations') IS NULL OR NOT EXISTS
      (SELECT 1 FROM schema_migrations WHERE name = '001_auth.sql' AND sha256 = '83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126') THEN
      RAISE EXCEPTION 'Mille migration history or checksum mismatch';
    END IF;
  END IF;
END; $mille_migration$;

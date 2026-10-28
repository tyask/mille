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

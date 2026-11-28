-- Mille schema. Verify the dedicated project, database and expected host before executing.
DO $mille_migration$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
  IF to_regclass('public.mille_environment') IS NULL THEN
    IF NOT true THEN RAISE EXCEPTION 'Explicit empty-database initialization is required'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r','p','v','m','S','f')) THEN
      RAISE EXCEPTION 'Mille initialization requires an empty dedicated database';
    END IF;
    EXECUTE 'CREATE TABLE mille_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project text NOT NULL CHECK (project = ''tyask/mille''),
  environment text NOT NULL CHECK (environment IN (''development'', ''preview'', ''production'')),
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
  IF EXISTS (SELECT 1 FROM mille_environment WHERE environment = ''production'')
    AND (NEW.is_test OR NEW.id LIKE ''mille-test-user-%'' OR NEW.email LIKE ''%@mille.invalid'') THEN
    RAISE EXCEPTION ''Production does not permit test users'';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mille_production_test_user_guard
BEFORE INSERT OR UPDATE ON app_users
FOR EACH ROW EXECUTE FUNCTION mille_reject_production_test_user();
';
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
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name NOT IN ('001_auth.sql', '002_workspaces.sql', '003_meals.sql', '004_meal_api.sql', '005_meal_plans.sql', '006_meal_suggestions.sql', '007_suggestion_gateway_preview.sql', '008_meal_photos.sql', '009_meal_ingredient_search.sql', '010_meal_photo_analysis.sql')) THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '001_auth.sql' AND sha256 <> '83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '002_workspaces.sql' AND sha256 <> '8ea6f940c097035d2c0e54417b60473b449219702f3aa232c24969c522c12eba') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '003_meals.sql' AND sha256 <> '6a00446fca1293f006ac71df6fa71f3a7b81c31e3009268c9811b5ed674473d4') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '004_meal_api.sql' AND sha256 <> 'b3992b6880d6d5bc86636fdf88d44dccd249dff431df471500742ebaec8eec2b') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '005_meal_plans.sql' AND sha256 <> 'afc13b2cb48c9e3e37e0c73cae90a0ac7a3c086829e7bd502bce163f8d5cb71a') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '006_meal_suggestions.sql' AND sha256 <> '210f984f9444211a81c2c82f120c38c3c9353b0ed7aceb42f5534a2be82cc857') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '007_suggestion_gateway_preview.sql' AND sha256 <> 'e0f6a8ea78ce0cf7d4078a503fa7cc7b0465523d8523efe2ba8fd9ea705b4f81') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '008_meal_photos.sql' AND sha256 <> '2d30b3a6437a0fe758491c578857ce678f3c243056c751b7185234a7497ab6b6') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '009_meal_ingredient_search.sql' AND sha256 <> 'b85f5eecb705ddaa490bebd249301a5ed99aa35461005eb59287853caf40b0d4') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '010_meal_photo_analysis.sql' AND sha256 <> '2f9be918b94291dfba67679aac29f405cdfd570fdad2118ae8dee903b0b915ce') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '002_workspaces.sql') THEN
    EXECUTE 'CREATE TABLE workspaces (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN (''PERSONAL'', ''SHARED'')),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN (''OWNER'', ''MEMBER'')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE workspace_invitations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inviter_id text NOT NULL REFERENCES app_users(id),
  email text NOT NULL CHECK (email = lower(btrim(email))),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ ''^[a-f0-9]{64}$''),
  status text NOT NULL DEFAULT ''PENDING'' CHECK (status IN (''PENDING'', ''ACCEPTED'')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);
CREATE INDEX workspace_invitations_recipient_idx ON workspace_invitations(email, status, expires_at);

CREATE FUNCTION mille_workspace_immutable_identity() RETURNS trigger AS $workspace_identity$
BEGIN
  IF NEW.type <> OLD.type OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION ''Workspace type and creator are immutable'' USING ERRCODE = ''23514'';
  END IF;
  RETURN NEW;
END;
$workspace_identity$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_immutable_identity BEFORE UPDATE OF type, created_by ON workspaces
  FOR EACH ROW EXECUTE FUNCTION mille_workspace_immutable_identity();

CREATE FUNCTION mille_workspace_personal_member() RETURNS trigger AS $personal_member$
DECLARE target workspaces%ROWTYPE;
BEGIN
  SELECT * INTO target FROM workspaces WHERE id = NEW.workspace_id FOR UPDATE;
  IF target.type = ''PERSONAL'' AND (NEW.user_id <> target.created_by OR NEW.role <> ''OWNER'') THEN
    RAISE EXCEPTION ''Personal workspace permits only its creator'' USING ERRCODE = ''23514'';
  END IF;
  RETURN NEW;
END;
$personal_member$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_personal_member BEFORE INSERT OR UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION mille_workspace_personal_member();

CREATE FUNCTION mille_workspace_json(target_id text, viewer_id text) RETURNS jsonb AS $workspace_json$
  SELECT jsonb_build_object(
    ''id'', w.id, ''name'', w.name, ''type'', w.type, ''role'', viewer.role,
    ''createdAt'', w.created_at, ''updatedAt'', w.updated_at,
    ''members'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      ''userId'', m.user_id, ''name'', u.name, ''email'', u.email, ''role'', m.role
    ) ORDER BY m.joined_at, m.user_id)
      FROM workspace_members m JOIN app_users u ON u.id = m.user_id WHERE m.workspace_id = w.id), ''[]''::jsonb),
    ''pendingInvitations'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      ''id'', i.id, ''email'', i.email, ''expiresAt'', i.expires_at
    ) ORDER BY i.created_at DESC, i.id) FROM workspace_invitations i
      WHERE i.workspace_id = w.id AND i.status = ''PENDING'' AND i.expires_at > now()), ''[]''::jsonb)
  ) FROM workspaces w JOIN workspace_members viewer ON viewer.workspace_id = w.id AND viewer.user_id = viewer_id
    JOIN app_users actor ON actor.id = viewer_id AND actor.is_enabled
    WHERE w.id = target_id;
$workspace_json$ LANGUAGE sql STABLE;

-- One invocation is one PostgreSQL transaction on both Neon HTTP and the local sidecar.
-- Domain errors are data so the sidecar never has to expose raw database errors.
CREATE FUNCTION mille_workspace_command(actor_id text, actor_email text, operation text, payload jsonb DEFAULT ''{}'')
RETURNS jsonb AS $workspace_command$
DECLARE
  actor app_users%ROWTYPE;
  target workspaces%ROWTYPE;
  invitation workspace_invitations%ROWTYPE;
  target_id text;
  normalized_name text;
  normalized_email text;
  result jsonb;
BEGIN
  SELECT * INTO actor FROM app_users u
    WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) AND u.is_enabled FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mille_environment WHERE environment = ''production''
    AND (actor.is_test OR actor.id LIKE ''mille-test-user-%'' OR actor.email LIKE ''%@mille.invalid'')) THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 401, ''error'', ''利用可能なアカウントでログインしてください。'');
  END IF;
  IF payload IS NULL OR jsonb_typeof(payload) <> ''object'' THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''入力内容を確認してください。'');
  END IF;

  IF operation = ''list'' THEN
    IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = actor.id) THEN
      INSERT INTO workspaces (name, type, created_by) VALUES (''個人のワークスペース'', ''PERSONAL'', actor.id) RETURNING id INTO target_id;
      INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (target_id, actor.id, ''OWNER'');
    END IF;
    SELECT jsonb_build_object(
      ''workspaces'', COALESCE((SELECT jsonb_agg(mille_workspace_json(w.id, actor.id)
        ORDER BY w.updated_at DESC, w.created_at DESC, w.id)
        FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = actor.id), ''[]''::jsonb),
      ''invitations'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        ''id'', i.id, ''email'', i.email, ''expiresAt'', i.expires_at,
        ''workspaceId'', i.workspace_id, ''workspaceName'', w.name, ''inviterName'', u.name
      ) ORDER BY i.created_at DESC, i.id) FROM workspace_invitations i
        JOIN workspaces w ON w.id = i.workspace_id JOIN app_users u ON u.id = i.inviter_id
        WHERE i.email = actor.email AND i.status = ''PENDING'' AND i.expires_at > now()), ''[]''::jsonb)
    ) INTO result;
    RETURN jsonb_build_object(''ok'', true, ''data'', result);
  END IF;

  IF operation = ''create'' THEN
    normalized_name := btrim(payload->>''name'');
    IF jsonb_typeof(payload->''name'') IS DISTINCT FROM ''string'' OR char_length(normalized_name) NOT BETWEEN 1 AND 80
      OR jsonb_typeof(payload->''type'') IS DISTINCT FROM ''string'' OR payload->>''type'' NOT IN (''PERSONAL'', ''SHARED'') THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''名前は1〜80文字で入力し、ワークスペースの種類を選んでください。'');
    END IF;
    INSERT INTO workspaces (name, type, created_by) VALUES (normalized_name, payload->>''type'', actor.id) RETURNING id INTO target_id;
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (target_id, actor.id, ''OWNER'');
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_workspace_json(target_id, actor.id));
  END IF;

  IF operation IN (''previewInvite'', ''acceptInvite'', ''acceptInviteById'') THEN
    IF operation = ''acceptInviteById'' THEN
      SELECT * INTO invitation FROM workspace_invitations WHERE id = payload->>''invitationId'';
    ELSE
      SELECT * INTO invitation FROM workspace_invitations WHERE token_hash = payload->>''tokenHash'';
    END IF;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 404, ''error'', ''招待が見つかりません。リンクを確認してください。'');
    END IF;
    -- All invitation mutations lock workspace first, then re-read the invitation.
    SELECT * INTO target FROM workspaces WHERE id = invitation.workspace_id FOR UPDATE;
    SELECT * INTO invitation FROM workspace_invitations i WHERE i.id = invitation.id
      AND (operation = ''acceptInviteById'' OR i.token_hash = payload->>''tokenHash'') FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 404, ''error'', ''招待が見つかりません。リンクを確認してください。'');
    END IF;
    IF invitation.email <> actor.email THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 403, ''error'', ''この招待は別のメールアドレス宛てです。招待されたアカウントでログインしてください。'');
    END IF;
    IF invitation.status = ''PENDING'' AND invitation.expires_at <= clock_timestamp() THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 410, ''error'', ''招待の有効期限が切れています。新しい招待リンクを発行してもらってください。'');
    END IF;
    IF target.type <> ''SHARED'' THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''個人用ワークスペースには参加できません。'');
    END IF;
    IF operation = ''previewInvite'' THEN
      SELECT jsonb_build_object(''id'', invitation.id, ''email'', invitation.email, ''expiresAt'', invitation.expires_at,
        ''workspaceId'', target.id, ''workspaceName'', target.name, ''inviterName'', u.name, ''status'', invitation.status)
        INTO result FROM app_users u WHERE u.id = invitation.inviter_id;
      RETURN jsonb_build_object(''ok'', true, ''data'', result);
    END IF;
    IF invitation.status = ''ACCEPTED'' AND NOT EXISTS
      (SELECT 1 FROM workspace_members WHERE workspace_id = target.id AND user_id = actor.id) THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 409, ''error'', ''この招待はすでに使用されています。'');
    END IF;
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (target.id, actor.id, ''MEMBER'')
      ON CONFLICT (workspace_id, user_id) DO NOTHING;
    UPDATE workspace_invitations SET status = ''ACCEPTED'' WHERE id = invitation.id;
    UPDATE workspaces SET updated_at = now() WHERE id = target.id;
    RETURN jsonb_build_object(''ok'', true, ''data'', jsonb_build_object(''workspaceId'', target.id));
  END IF;

  IF operation NOT IN (''rename'', ''delete'', ''invite'') THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''操作を確認してください。'');
  END IF;
  SELECT * INTO target FROM workspaces w WHERE w.id = payload->>''id'' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = target.id AND user_id = actor.id) THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 404, ''error'', ''ワークスペースが見つからないか、アクセス権がありません。'');
  END IF;

  IF operation = ''rename'' THEN
    normalized_name := btrim(payload->>''name'');
    IF jsonb_typeof(payload->''name'') IS DISTINCT FROM ''string'' OR char_length(normalized_name) NOT BETWEEN 1 AND 80 THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''名前は1〜80文字で入力してください。'');
    END IF;
    UPDATE workspaces SET name = normalized_name, updated_at = now() WHERE id = target.id;
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_workspace_json(target.id, actor.id));
  END IF;

  IF operation = ''delete'' THEN
    IF payload->>''confirmationName'' IS DISTINCT FROM target.name THEN
      RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''確認用のワークスペース名が一致しません。'');
    END IF;
    DELETE FROM workspaces WHERE id = target.id;
    RETURN jsonb_build_object(''ok'', true, ''data'', NULL);
  END IF;

  IF target.type <> ''SHARED'' THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''招待できるのは共有ワークスペースだけです。'');
  END IF;
  normalized_email := lower(btrim(payload->>''email''));
  IF jsonb_typeof(payload->''email'') IS DISTINCT FROM ''string'' OR char_length(normalized_email) > 254
    OR normalized_email !~ ''^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$''
    OR jsonb_typeof(payload->''tokenHash'') IS DISTINCT FROM ''string'' OR payload->>''tokenHash'' !~ ''^[a-f0-9]{64}$'' THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''メールアドレスと招待情報を確認してください。'');
  END IF;
  IF normalized_email = actor.email THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 400, ''error'', ''自分自身は招待できません。'');
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_members m JOIN app_users u ON u.id = m.user_id
    WHERE m.workspace_id = target.id AND u.email = normalized_email) THEN
    RETURN jsonb_build_object(''ok'', false, ''status'', 409, ''error'', ''この利用者はすでに参加しています。'');
  END IF;
  INSERT INTO workspace_invitations (workspace_id, inviter_id, email, token_hash, expires_at)
    VALUES (target.id, actor.id, normalized_email, payload->>''tokenHash'', now() + interval ''7 days'')
    ON CONFLICT (workspace_id, email) DO UPDATE SET inviter_id = EXCLUDED.inviter_id, token_hash = EXCLUDED.token_hash,
      status = ''PENDING'', expires_at = EXCLUDED.expires_at, created_at = now()
    RETURNING * INTO invitation;
  UPDATE workspaces SET updated_at = now() WHERE id = target.id;
  RETURN jsonb_build_object(''ok'', true, ''data'', jsonb_build_object(
    ''id'', invitation.id, ''email'', invitation.email, ''expiresAt'', invitation.expires_at));
END;
$workspace_command$ LANGUAGE plpgsql;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('002_workspaces.sql','8ea6f940c097035d2c0e54417b60473b449219702f3aa232c24969c522c12eba');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '003_meals.sql') THEN
    EXECUTE 'CREATE TABLE meals (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meal_date date NOT NULL CHECK (meal_date BETWEEN DATE ''0001-01-01'' AND DATE ''9999-12-31''),
  meal_type text NOT NULL CHECK (meal_type IN (''BREAKFAST'', ''LUNCH'', ''DINNER'')),
  status text NOT NULL DEFAULT ''RECORDED'' CHECK (status = ''RECORDED''),
  servings numeric CHECK (servings BETWEEN 0.01 AND 99 AND min_scale(servings) <= 2),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES app_users(id),
  updated_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meals_workspace_slot_uq UNIQUE (workspace_id, meal_date, meal_type)
);

CREATE TABLE meal_dishes (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  meal_id text NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 19),
  name text NOT NULL CHECK (name = btrim(name) AND name COLLATE "C" ~ ''[^[:space:]]'' AND char_length(name) <= 120),
  servings numeric CHECK (servings BETWEEN 0.01 AND 99 AND min_scale(servings) <= 2),
  recipe_text text CHECK (char_length(recipe_text) <= 10000),
  recipe_url text CHECK (char_length(recipe_url) <= 2048),
  CHECK (recipe_text IS NULL OR recipe_url IS NULL),
  CONSTRAINT meal_dishes_position_uq UNIQUE (meal_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE dish_ingredients (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  dish_id text NOT NULL REFERENCES meal_dishes(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 99),
  name text NOT NULL CHECK (name = btrim(name) AND name COLLATE "C" ~ ''[^[:space:]]'' AND char_length(name) <= 120),
  amount_text text CHECK (char_length(amount_text) <= 40),
  unit text CHECK (char_length(unit) <= 20),
  CONSTRAINT dish_ingredients_position_uq UNIQUE (dish_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION mille_meal_date(input text) RETURNS date AS $meal_date$
BEGIN
  IF input !~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}$'' THEN RETURN NULL; END IF;
  RETURN input::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$meal_date$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION mille_meal_number_valid(input jsonb, minimum numeric, maximum numeric, decimal_places integer)
RETURNS boolean AS $meal_number$
  SELECT CASE WHEN jsonb_typeof(input) = ''number'' THEN
    (input #>> ''{}'')::numeric BETWEEN minimum AND maximum
      AND min_scale((input #>> ''{}'')::numeric) <= decimal_places
    ELSE false END;
$meal_number$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_name_valid(input jsonb) RETURNS boolean AS $meal_name$
  SELECT jsonb_typeof(input) IS NOT DISTINCT FROM ''string''
    AND (input #>> ''{}'') = btrim(input #>> ''{}'')
    AND (input #>> ''{}'') COLLATE "C" ~ ''[^[:space:]]'' AND char_length(input #>> ''{}'') <= 120;
$meal_name$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_optional_text_valid(input jsonb, maximum integer) RETURNS boolean AS $meal_text$
  SELECT CASE jsonb_typeof(input)
    WHEN ''null'' THEN true
    WHEN ''string'' THEN char_length(input #>> ''{}'') BETWEEN 1 AND maximum
    ELSE false END;
$meal_text$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_error(code text, current_version integer DEFAULT NULL) RETURNS jsonb AS $meal_error$
  SELECT jsonb_strip_nulls(jsonb_build_object(''ok'', false, ''code'', code, ''currentVersion'', current_version,
    ''status'', CASE code
      WHEN ''UNAUTHENTICATED'' THEN 401 WHEN ''NOT_FOUND'' THEN 404 WHEN ''INVALID_INPUT'' THEN 400 ELSE 409 END,
    ''error'', CASE code
      WHEN ''UNAUTHENTICATED'' THEN ''利用可能なアカウントでログインしてください。''
      WHEN ''NOT_FOUND'' THEN ''献立またはワークスペースが見つかりません。''
      WHEN ''INVALID_INPUT'' THEN ''入力内容を確認してください。''
      WHEN ''SLOT_OCCUPIED'' THEN ''指定した日付と食事区分にはすでに献立があります。''
      WHEN ''VERSION_CONFLICT'' THEN ''ほかの家族がこの献立を更新しました。最新版を確認してください。'' END));
$meal_error$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_actor_allowed(actor app_users) RETURNS boolean AS $meal_actor$
  SELECT (actor).is_enabled AND NOT EXISTS (
    SELECT 1 FROM mille_environment WHERE environment = ''production''
      AND ((actor).is_test OR (actor).id LIKE ''mille-test-user-%'' OR (actor).email LIKE ''%@mille.invalid'')
  );
$meal_actor$ LANGUAGE sql STABLE;

CREATE FUNCTION mille_meal_json(meal meals, include_details boolean) RETURNS jsonb AS $meal_json$
  SELECT jsonb_build_object(
    ''id'', (meal).id, ''workspaceId'', (meal).workspace_id, ''mealDate'', to_char((meal).meal_date, ''YYYY-MM-DD''),
    ''mealType'', (meal).meal_type, ''status'', (meal).status, ''servings'', (meal).servings, ''version'', (meal).version,
    ''updatedBy'', jsonb_build_object(''id'', updater.id, ''name'', updater.name),
    ''updatedAt'', to_char((meal).updated_at AT TIME ZONE ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"''),
    ''dishes'', COALESCE((SELECT jsonb_agg(
      jsonb_build_object(''id'', d.id, ''position'', d.position, ''name'', d.name)
      || CASE WHEN include_details THEN jsonb_build_object(
        ''servings'', d.servings, ''recipeText'', d.recipe_text, ''recipeUrl'', d.recipe_url,
        ''ingredients'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          ''id'', i.id, ''name'', i.name, ''amountText'', i.amount_text, ''unit'', i.unit
        ) ORDER BY i.position) FROM dish_ingredients i WHERE i.dish_id = d.id), ''[]''::jsonb)
      ) ELSE ''{}''::jsonb END ORDER BY d.position
    ) FROM meal_dishes d WHERE d.meal_id = (meal).id), ''[]''::jsonb)
  ) FROM app_users updater WHERE updater.id = (meal).updated_by;
$meal_json$ LANGUAGE sql STABLE;

-- STABLE keeps the actor, membership and meal reads on one statement snapshot.
CREATE FUNCTION mille_meal_read(actor_id text, actor_email text, operation text, payload jsonb)
RETURNS jsonb AS $meal_read$
DECLARE
  target_workspace text;
  range_start date;
  range_end date;
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email))
    AND mille_meal_actor_allowed(u)) THEN
    RETURN mille_meal_error(''UNAUTHENTICATED'');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  target_workspace := payload->>''workspaceId'';
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;

  IF operation = ''list'' THEN
    range_start := mille_meal_date(payload->>''from'');
    -- The expanded ISO date is only accepted as the exclusive end of 9999-12-31.
    range_end := CASE WHEN payload->>''to'' = ''+010000-01-01'' THEN DATE ''10000-01-01''
      ELSE mille_meal_date(payload->>''to'') END;
    IF range_start IS NULL OR range_end IS NULL OR range_end - range_start NOT BETWEEN 1 AND 62 THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    SELECT COALESCE(jsonb_agg(mille_meal_json(m, false) ORDER BY m.meal_date,
      CASE m.meal_type WHEN ''BREAKFAST'' THEN 1 WHEN ''LUNCH'' THEN 2 ELSE 3 END), ''[]''::jsonb)
      INTO result FROM meals m WHERE m.workspace_id = target_workspace AND m.meal_date >= range_start AND m.meal_date < range_end;
  ELSIF operation = ''get'' THEN
    IF jsonb_typeof(payload->''mealId'') IS DISTINCT FROM ''string'' THEN RETURN mille_meal_error(''INVALID_INPUT''); END IF;
    SELECT mille_meal_json(m, true) INTO result FROM meals m
      WHERE m.workspace_id = target_workspace AND m.id = payload->>''mealId'';
    IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
  ELSE
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  RETURN jsonb_build_object(''ok'', true, ''data'', result);
END;
$meal_read$ LANGUAGE plpgsql STABLE;

-- A retained ID must belong to the existing parent. A new parent can only receive new children.
CREATE FUNCTION mille_meal_dishes_valid(input jsonb, existing_meal_id text) RETURNS boolean AS $meal_dishes_valid$
DECLARE
  dish jsonb;
  existing_dish_id text;
  recipe_url text;
  seen_dish_ids text[] := ''{}'';
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM ''array'' THEN RETURN false; END IF;
  IF jsonb_array_length(input) NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
  FOR dish IN SELECT value FROM jsonb_array_elements(input) LOOP
    IF jsonb_typeof(dish) IS DISTINCT FROM ''object'' OR NOT mille_meal_name_valid(dish->''name'')
      OR (NOT COALESCE(dish->''servings'' = ''null''::jsonb, false) AND NOT mille_meal_number_valid(dish->''servings'', 0.01, 99, 2))
      OR NOT mille_meal_optional_text_valid(dish->''recipeText'', 10000)
      OR NOT mille_meal_optional_text_valid(dish->''recipeUrl'', 2048)
      OR jsonb_typeof(dish->''ingredients'') IS DISTINCT FROM ''array'' THEN RETURN false; END IF;
    IF jsonb_array_length(dish->''ingredients'') > 100 THEN RETURN false; END IF;
    recipe_url := dish->>''recipeUrl'';
    IF recipe_url IS NOT NULL AND (dish->>''recipeText'' IS NOT NULL
      OR recipe_url !~* ''^https?://[^/?#@]+([/?#].*)?$''
      OR recipe_url COLLATE "C" ~ ''[[:space:]]'' OR strpos(recipe_url, chr(92)) > 0) THEN RETURN false; END IF;

    existing_dish_id := dish->>''id'';
    IF dish ? ''id'' THEN
      IF jsonb_typeof(dish->''id'') IS DISTINCT FROM ''string'' OR existing_dish_id = ANY(seen_dish_ids)
        OR NOT EXISTS (SELECT 1 FROM meal_dishes d WHERE d.id = existing_dish_id AND d.meal_id = existing_meal_id) THEN
        RETURN false;
      END IF;
      seen_dish_ids := array_append(seen_dish_ids, existing_dish_id);
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(dish->''ingredients'') AS inputs(ingredient)
      WHERE jsonb_typeof(ingredient) IS DISTINCT FROM ''object'' OR NOT mille_meal_name_valid(ingredient->''name'')
        OR NOT mille_meal_optional_text_valid(ingredient->''amountText'', 40)
        OR NOT mille_meal_optional_text_valid(ingredient->''unit'', 20)
        OR (ingredient ? ''id'' AND (jsonb_typeof(ingredient->''id'') IS DISTINCT FROM ''string''
          OR NOT EXISTS (SELECT 1 FROM dish_ingredients i WHERE i.id = ingredient->>''id'' AND i.dish_id = existing_dish_id))))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(dish->''ingredients'') AS inputs(ingredient)
        WHERE ingredient ? ''id'' GROUP BY ingredient->>''id'' HAVING count(*) > 1) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$meal_dishes_valid$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION mille_meal_command(actor_id text, actor_email text, operation text, payload jsonb)
RETURNS jsonb AS $meal_command$
DECLARE
  actor app_users%ROWTYPE;
  target_workspace text;
  saved_meal meals%ROWTYPE;
  target_date date;
  target_type text;
  dish record;
  saved_dish_id text;
  conflict_constraint text;
BEGIN
  -- Use the same lock order as workspace writes so disable/delete and meal writes serialize.
  SELECT u.* INTO actor FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error(''UNAUTHENTICATED''); END IF;
  IF operation IS NULL OR operation NOT IN (''create'', ''update'', ''delete'')
    OR jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>''workspaceId'' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;

  IF operation <> ''create'' THEN
    IF jsonb_typeof(payload->''mealId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''expectedVersion'', 1, 2147483647, 0) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    SELECT m.* INTO saved_meal FROM meals m WHERE m.id = payload->>''mealId'' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
    IF saved_meal.version <> (payload->>''expectedVersion'')::numeric THEN
      RETURN mille_meal_error(''VERSION_CONFLICT'', saved_meal.version);
    END IF;
  END IF;

  IF operation <> ''delete'' THEN
    target_date := mille_meal_date(payload->>''mealDate'');
    target_type := payload->>''mealType'';
    IF target_date IS NULL OR target_type IS NULL OR target_type NOT IN (''BREAKFAST'', ''LUNCH'', ''DINNER'')
      OR (NOT COALESCE(payload->''servings'' = ''null''::jsonb, false) AND NOT mille_meal_number_valid(payload->''servings'', 0.01, 99, 2))
      OR NOT mille_meal_dishes_valid(payload->''dishes'', saved_meal.id) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
  END IF;

  -- Convert known conflicts only inside a subtransaction so any partial changes are rolled back.
  BEGIN
    IF operation = ''delete'' THEN
      DELETE FROM meals WHERE id = saved_meal.id;
      RETURN jsonb_build_object(''ok'', true, ''data'', NULL);
    END IF;

    SET CONSTRAINTS meal_dishes_position_uq, dish_ingredients_position_uq DEFERRED;
    IF operation = ''create'' THEN
      INSERT INTO meals (workspace_id, meal_date, meal_type, servings, created_by, updated_by)
        VALUES (target_workspace, target_date, target_type, (payload->>''servings'')::numeric, actor.id, actor.id)
        RETURNING * INTO saved_meal;
    ELSE
      UPDATE meals m SET meal_date = target_date, meal_type = target_type, servings = (payload->>''servings'')::numeric,
        version = m.version + 1, updated_by = actor.id, updated_at = clock_timestamp()
        WHERE m.id = saved_meal.id RETURNING * INTO saved_meal;
      DELETE FROM meal_dishes d WHERE d.meal_id = saved_meal.id AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(payload->''dishes'') AS input(value) WHERE value->>''id'' = d.id);
    END IF;

    FOR dish IN SELECT value, ordinality - 1 AS position FROM jsonb_array_elements(payload->''dishes'') WITH ORDINALITY LOOP
      saved_dish_id := dish.value->>''id'';
      IF saved_dish_id IS NULL THEN
        INSERT INTO meal_dishes (meal_id, position, name, servings, recipe_text, recipe_url)
          VALUES (saved_meal.id, dish.position, dish.value->>''name'', (dish.value->>''servings'')::numeric,
            dish.value->>''recipeText'', dish.value->>''recipeUrl'') RETURNING id INTO saved_dish_id;
      ELSE
        UPDATE meal_dishes d SET position = dish.position, name = dish.value->>''name'', servings = (dish.value->>''servings'')::numeric,
          recipe_text = dish.value->>''recipeText'', recipe_url = dish.value->>''recipeUrl''
          WHERE d.id = saved_dish_id AND d.meal_id = saved_meal.id;
        DELETE FROM dish_ingredients i WHERE i.dish_id = saved_dish_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(dish.value->''ingredients'') AS input(value) WHERE value->>''id'' = i.id);
        UPDATE dish_ingredients i SET position = input.ordinality - 1, name = input.value->>''name'',
          amount_text = input.value->>''amountText'', unit = input.value->>''unit''
          FROM jsonb_array_elements(dish.value->''ingredients'') WITH ORDINALITY AS input(value, ordinality)
          WHERE i.dish_id = saved_dish_id AND i.id = input.value->>''id'';
      END IF;
      INSERT INTO dish_ingredients (dish_id, position, name, amount_text, unit)
        SELECT saved_dish_id, ordinality - 1, value->>''name'', value->>''amountText'', value->>''unit''
          FROM jsonb_array_elements(dish.value->''ingredients'') WITH ORDINALITY WHERE NOT (value ? ''id'');
    END LOOP;

    SET CONSTRAINTS meal_dishes_position_uq, dish_ingredients_position_uq IMMEDIATE;
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_meal_json(saved_meal, true));
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
    IF conflict_constraint = ''meals_workspace_slot_uq'' THEN RETURN mille_meal_error(''SLOT_OCCUPIED''); END IF;
    RAISE;
  END;
END;
$meal_command$ LANGUAGE plpgsql;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('003_meals.sql','6a00446fca1293f006ac71df6fa71f3a7b81c31e3009268c9811b5ed674473d4');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '004_meal_api.sql') THEN
    EXECUTE 'CREATE TABLE meal_command_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES app_users(id),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 128),
  operation text NOT NULL CHECK (operation IN (''create'', ''update'', ''delete'', ''copy'')),
  request_hash text NOT NULL CHECK (request_hash ~ ''^[a-f0-9]{64}$''),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, request_key)
);

CREATE INDEX meal_command_requests_scope_expiry_idx
  ON meal_command_requests (workspace_id, actor_id, expires_at);

CREATE INDEX meals_workspace_search_order_idx
  ON meals (workspace_id, meal_date DESC, id DESC);

CREATE FUNCTION mille_meal_command_idempotent(
  actor_id text, actor_email text, operation text, payload jsonb, idempotency_key text, request_hash text
) RETURNS jsonb AS $meal_idempotent$
DECLARE
  actor app_users%ROWTYPE;
  target_workspace text;
  previous_request meal_command_requests%ROWTYPE;
  source_meal meals%ROWTYPE;
  target_date date;
  target_type text;
  copy_dishes jsonb;
  result jsonb;
  written_at timestamptz;
BEGIN
  -- Take the same locks in the same order as the original command. This also serializes replay with disabling or deleting.
  SELECT u.* INTO actor FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error(''UNAUTHENTICATED''); END IF;
  IF operation IS NULL OR operation NOT IN (''create'', ''update'', ''delete'', ''copy'')
    OR jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string''
    OR idempotency_key IS NULL OR idempotency_key COLLATE "C" !~ ''^[!-~]{1,128}$'' OR strpos(idempotency_key, '','') > 0
    OR request_hash IS NULL OR request_hash COLLATE "C" !~ ''^[a-f0-9]{64}$'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>''workspaceId'' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;

  SELECT r.* INTO previous_request FROM meal_command_requests r
    WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id AND r.request_key = idempotency_key
      AND r.expires_at > clock_timestamp();
  IF FOUND THEN
    IF previous_request.operation = operation AND previous_request.request_hash = request_hash THEN
      RETURN previous_request.response_json;
    END IF;
    RETURN jsonb_build_object(''ok'', false, ''code'', ''IDEMPOTENCY_KEY_REUSED'', ''status'', 409,
      ''error'', ''この送信キーは別の操作または入力で使用済みです。'');
  END IF;

  IF operation = ''copy'' THEN
    target_date := mille_meal_date(payload->>''targetDate'');
    target_type := payload->>''targetMealType'';
    IF jsonb_typeof(payload->''mealId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''sourceVersion'', 1, 2147483647, 0)
      OR target_date IS NULL OR target_type IS NULL OR target_type NOT IN (''BREAKFAST'', ''LUNCH'', ''DINNER'') THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    SELECT m.* INTO source_meal FROM meals m
      WHERE m.id = payload->>''mealId'' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
    IF source_meal.version <> (payload->>''sourceVersion'')::numeric THEN
      RETURN mille_meal_error(''VERSION_CONFLICT'', source_meal.version);
    END IF;

    -- Reuse the existing create operation with a fresh snapshot that contains no child IDs.
    SELECT jsonb_agg(jsonb_build_object(
      ''name'', d.name, ''servings'', d.servings, ''recipeText'', d.recipe_text, ''recipeUrl'', d.recipe_url,
      ''ingredients'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        ''name'', i.name, ''amountText'', i.amount_text, ''unit'', i.unit
      ) ORDER BY i.position) FROM dish_ingredients i WHERE i.dish_id = d.id), ''[]''::jsonb)
    ) ORDER BY d.position) INTO copy_dishes FROM meal_dishes d WHERE d.meal_id = source_meal.id;
    result := mille_meal_command(actor.id, actor.email, ''create'', jsonb_build_object(
      ''workspaceId'', target_workspace, ''mealDate'', payload->>''targetDate'', ''mealType'', target_type,
      ''servings'', source_meal.servings, ''dishes'', copy_dishes));
  ELSE
    result := mille_meal_command(actor.id, actor.email, operation, payload);
  END IF;

  IF (result->>''ok'')::boolean THEN
    written_at := clock_timestamp();
    DELETE FROM meal_command_requests r WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id
      AND r.expires_at <= written_at;
    INSERT INTO meal_command_requests (workspace_id, actor_id, request_key, operation, request_hash, response_json, created_at, expires_at)
      VALUES (target_workspace, actor.id, idempotency_key, operation, request_hash, result, written_at, written_at + interval ''24 hours'');
  END IF;
  RETURN result;
END;
$meal_idempotent$ LANGUAGE plpgsql;

CREATE FUNCTION mille_meal_dish_search(actor_id text, actor_email text, payload jsonb)
RETURNS jsonb AS $meal_dish_search$
DECLARE
  target_workspace text;
  search_term text;
  search_pattern text;
  page_limit integer;
  after_date date;
  after_meal text;
  after_position integer;
  after_dish text;
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email))
    AND mille_meal_actor_allowed(u)) THEN
    RETURN mille_meal_error(''UNAUTHENTICATED'');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  target_workspace := payload->>''workspaceId'';
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;
  search_term := payload->>''q'';
  IF jsonb_typeof(payload->''q'') IS DISTINCT FROM ''string'' OR char_length(search_term) NOT BETWEEN 1 AND 100
    OR NOT mille_meal_number_valid(payload->''limit'', 1, 50, 0) THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  page_limit := (payload->>''limit'')::numeric::integer;
  IF payload ? ''cursor'' THEN
    after_date := mille_meal_date(payload->''cursor''->>''mealDate'');
    IF jsonb_typeof(payload->''cursor'') IS DISTINCT FROM ''object'' OR after_date IS NULL
      OR jsonb_typeof(payload->''cursor''->''mealId'') IS DISTINCT FROM ''string''
      OR jsonb_typeof(payload->''cursor''->''dishId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''cursor''->''position'', 0, 19, 0) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    after_meal := payload->''cursor''->>''mealId'';
    after_dish := payload->''cursor''->>''dishId'';
    after_position := (payload->''cursor''->>''position'')::numeric::integer;
  END IF;

  search_pattern := ''%'' || replace(replace(replace(search_term, chr(92), chr(92) || chr(92)),
    ''%'', chr(92) || ''%''), ''_'', chr(92) || ''_'') || ''%'';
  WITH page AS (
    SELECT m.meal_date, m.meal_type, m.id AS meal_id, d.id AS dish_id, d.position, d.name
    FROM meals m JOIN meal_dishes d ON d.meal_id = m.id
    WHERE m.workspace_id = target_workspace AND d.name ILIKE search_pattern ESCAPE chr(92)
      AND (after_date IS NULL OR (m.meal_date, m.id) < (after_date, after_meal)
        OR (m.meal_date = after_date AND m.id = after_meal AND (d.position, d.id) > (after_position, after_dish)))
    ORDER BY m.meal_date DESC, m.id DESC, d.position, d.id
    LIMIT page_limit + 1
  ), numbered AS (
    SELECT page.*, row_number() OVER (ORDER BY meal_date DESC, meal_id DESC, position, dish_id) AS row_index FROM page
  ), encoded AS (
    SELECT row_index, jsonb_build_object(''mealDate'', to_char(meal_date, ''YYYY-MM-DD''),
      ''mealId'', meal_id, ''position'', position, ''dishId'', dish_id) AS cursor_values, meal_type, name
    FROM numbered
  )
  SELECT jsonb_build_object(
    ''items'', COALESCE(jsonb_agg(cursor_values || jsonb_build_object(''mealType'', meal_type, ''dishName'', name)
      ORDER BY row_index) FILTER (WHERE row_index <= page_limit), ''[]''::jsonb),
    ''nextCursor'', CASE WHEN count(*) > page_limit
      THEN jsonb_agg(cursor_values) FILTER (WHERE row_index = page_limit)->0 ELSE NULL END
  ) INTO result FROM encoded;
  RETURN jsonb_build_object(''ok'', true, ''data'', result);
END;
$meal_dish_search$ LANGUAGE plpgsql STABLE;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('004_meal_api.sql','b3992b6880d6d5bc86636fdf88d44dccd249dff431df471500742ebaec8eec2b');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '005_meal_plans.sql') THEN
    EXECUTE 'ALTER TABLE meals DROP CONSTRAINT meals_status_check,
  ADD CONSTRAINT meals_status_check CHECK (status IN (''RECORDED'', ''PLANNED''));

ALTER TABLE meal_command_requests DROP CONSTRAINT meal_command_requests_operation_check,
  ADD CONSTRAINT meal_command_requests_operation_check CHECK (operation IN (''create'', ''update'', ''delete'', ''copy'', ''record''));

CREATE OR REPLACE FUNCTION mille_meal_error(code text, current_version integer DEFAULT NULL) RETURNS jsonb AS $meal_error$
  SELECT jsonb_strip_nulls(jsonb_build_object(''ok'', false, ''code'', code, ''currentVersion'', current_version,
    ''status'', CASE code
      WHEN ''UNAUTHENTICATED'' THEN 401 WHEN ''NOT_FOUND'' THEN 404 WHEN ''INVALID_INPUT'' THEN 400 ELSE 409 END,
    ''error'', CASE code
      WHEN ''UNAUTHENTICATED'' THEN ''利用可能なアカウントでログインしてください。''
      WHEN ''NOT_FOUND'' THEN ''献立またはワークスペースが見つかりません。''
      WHEN ''INVALID_INPUT'' THEN ''入力内容を確認してください。''
      WHEN ''SLOT_OCCUPIED'' THEN ''指定した日付と食事区分にはすでに献立があります。''
      WHEN ''VERSION_CONFLICT'' THEN ''ほかの家族がこの献立を更新しました。最新版を確認してください。''
      WHEN ''NOT_PLANNED'' THEN ''予定の献立だけを記録済みにできます。''
      WHEN ''NOT_RECORDED'' THEN ''記録済みの献立だけをコピーできます。'' END));
$meal_error$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION mille_meal_command(actor_id text, actor_email text, operation text, payload jsonb)
RETURNS jsonb AS $meal_command$
DECLARE
  actor app_users%ROWTYPE;
  target_workspace text;
  saved_meal meals%ROWTYPE;
  target_date date;
  target_type text;
  dish record;
  saved_dish_id text;
  conflict_constraint text;
BEGIN
  -- Use the same lock order as workspace writes so disable/delete and meal writes serialize.
  SELECT u.* INTO actor FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error(''UNAUTHENTICATED''); END IF;
  IF operation IS NULL OR operation NOT IN (''create'', ''update'', ''delete'', ''adopt'', ''record'')
    OR jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>''workspaceId'' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;

  IF operation = ''adopt'' THEN
    target_date := mille_meal_date(payload->>''mealDate'');
    target_type := payload->>''mealType'';
    IF target_date IS NULL OR target_type IS NULL OR target_type NOT IN (''BREAKFAST'', ''LUNCH'', ''DINNER'')
      OR (payload ? ''replaceMealId'') <> (payload ? ''replaceVersion'')
      OR (payload ? ''replaceMealId'' AND (
        jsonb_typeof(payload->''replaceMealId'') IS DISTINCT FROM ''string'' OR btrim(payload->>''replaceMealId'') = ''''
        OR NOT mille_meal_number_valid(payload->''replaceVersion'', 1, 2147483647, 0)
      )) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;

    SELECT m.* INTO saved_meal FROM meals m
      WHERE m.workspace_id = target_workspace AND m.meal_date = target_date AND m.meal_type = target_type FOR UPDATE;
    IF saved_meal.status = ''RECORDED'' THEN RETURN mille_meal_error(''SLOT_OCCUPIED''); END IF;
    IF payload ? ''replaceMealId'' THEN
      IF saved_meal.id IS DISTINCT FROM (payload->>''replaceMealId'')
        OR saved_meal.version IS DISTINCT FROM (payload->>''replaceVersion'')::numeric THEN
        RETURN mille_meal_error(''VERSION_CONFLICT'', saved_meal.version);
      END IF;
    ELSIF saved_meal.id IS NOT NULL THEN
      RETURN mille_meal_error(''SLOT_OCCUPIED'');
    END IF;
  ELSIF operation <> ''create'' THEN
    IF jsonb_typeof(payload->''mealId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''expectedVersion'', 1, 2147483647, 0) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    SELECT m.* INTO saved_meal FROM meals m WHERE m.id = payload->>''mealId'' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
    IF saved_meal.version <> (payload->>''expectedVersion'')::numeric THEN
      RETURN mille_meal_error(''VERSION_CONFLICT'', saved_meal.version);
    END IF;
    IF operation = ''record'' AND saved_meal.status <> ''PLANNED'' THEN
      RETURN mille_meal_error(''NOT_PLANNED'');
    END IF;
  END IF;

  IF operation <> ''delete'' THEN
    IF operation <> ''adopt'' THEN
      target_date := mille_meal_date(payload->>''mealDate'');
      target_type := payload->>''mealType'';
    END IF;
    IF target_date IS NULL OR target_type IS NULL OR target_type NOT IN (''BREAKFAST'', ''LUNCH'', ''DINNER'')
      OR (operation = ''record'' AND (target_date <> saved_meal.meal_date OR target_type <> saved_meal.meal_type))
      OR (NOT COALESCE(payload->''servings'' = ''null''::jsonb, false) AND NOT mille_meal_number_valid(payload->''servings'', 0.01, 99, 2))
      OR NOT mille_meal_dishes_valid(payload->''dishes'', CASE WHEN operation = ''adopt'' THEN NULL ELSE saved_meal.id END) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
  END IF;

  -- Convert known conflicts only inside a subtransaction so any partial changes are rolled back.
  BEGIN
    IF operation = ''delete'' THEN
      DELETE FROM meals WHERE id = saved_meal.id;
      RETURN jsonb_build_object(''ok'', true, ''data'', NULL);
    END IF;

    SET CONSTRAINTS meal_dishes_position_uq, dish_ingredients_position_uq DEFERRED;
    IF saved_meal.id IS NULL THEN
      INSERT INTO meals (workspace_id, meal_date, meal_type, status, servings, created_by, updated_by)
        VALUES (target_workspace, target_date, target_type, CASE WHEN operation = ''adopt'' THEN ''PLANNED'' ELSE ''RECORDED'' END,
          (payload->>''servings'')::numeric, actor.id, actor.id)
        RETURNING * INTO saved_meal;
    ELSE
      UPDATE meals m SET meal_date = target_date, meal_type = target_type, servings = (payload->>''servings'')::numeric,
        status = CASE WHEN operation = ''record'' THEN ''RECORDED'' ELSE m.status END,
        version = m.version + 1, updated_by = actor.id, updated_at = clock_timestamp()
        WHERE m.id = saved_meal.id RETURNING * INTO saved_meal;
      DELETE FROM meal_dishes d WHERE d.meal_id = saved_meal.id AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(payload->''dishes'') AS input(value) WHERE value->>''id'' = d.id);
    END IF;

    FOR dish IN SELECT value, ordinality - 1 AS position FROM jsonb_array_elements(payload->''dishes'') WITH ORDINALITY LOOP
      saved_dish_id := dish.value->>''id'';
      IF saved_dish_id IS NULL THEN
        INSERT INTO meal_dishes (meal_id, position, name, servings, recipe_text, recipe_url)
          VALUES (saved_meal.id, dish.position, dish.value->>''name'', (dish.value->>''servings'')::numeric,
            dish.value->>''recipeText'', dish.value->>''recipeUrl'') RETURNING id INTO saved_dish_id;
      ELSE
        UPDATE meal_dishes d SET position = dish.position, name = dish.value->>''name'', servings = (dish.value->>''servings'')::numeric,
          recipe_text = dish.value->>''recipeText'', recipe_url = dish.value->>''recipeUrl''
          WHERE d.id = saved_dish_id AND d.meal_id = saved_meal.id;
        DELETE FROM dish_ingredients i WHERE i.dish_id = saved_dish_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(dish.value->''ingredients'') AS input(value) WHERE value->>''id'' = i.id);
        UPDATE dish_ingredients i SET position = input.ordinality - 1, name = input.value->>''name'',
          amount_text = input.value->>''amountText'', unit = input.value->>''unit''
          FROM jsonb_array_elements(dish.value->''ingredients'') WITH ORDINALITY AS input(value, ordinality)
          WHERE i.dish_id = saved_dish_id AND i.id = input.value->>''id'';
      END IF;
      INSERT INTO dish_ingredients (dish_id, position, name, amount_text, unit)
        SELECT saved_dish_id, ordinality - 1, value->>''name'', value->>''amountText'', value->>''unit''
          FROM jsonb_array_elements(dish.value->''ingredients'') WITH ORDINALITY WHERE NOT (value ? ''id'');
    END LOOP;

    SET CONSTRAINTS meal_dishes_position_uq, dish_ingredients_position_uq IMMEDIATE;
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_meal_json(saved_meal, true));
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
    IF conflict_constraint = ''meals_workspace_slot_uq'' THEN RETURN mille_meal_error(''SLOT_OCCUPIED''); END IF;
    RAISE;
  END;
END;
$meal_command$ LANGUAGE plpgsql;

-- The suggestion command validates the candidate and records the replay result in the same transaction.
CREATE FUNCTION mille_meal_adopt_plan(actor_id text, actor_email text, payload jsonb)
RETURNS jsonb AS $meal_adopt$
  SELECT mille_meal_command(actor_id, actor_email, ''adopt'', payload);
$meal_adopt$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION mille_meal_command_idempotent(
  actor_id text, actor_email text, operation text, payload jsonb, idempotency_key text, request_hash text
) RETURNS jsonb AS $meal_idempotent$
DECLARE
  actor app_users%ROWTYPE;
  target_workspace text;
  previous_request meal_command_requests%ROWTYPE;
  source_meal meals%ROWTYPE;
  target_date date;
  target_type text;
  copy_dishes jsonb;
  result jsonb;
  written_at timestamptz;
BEGIN
  -- Take the same locks in the same order as the original command. This also serializes replay with disabling or deleting.
  SELECT u.* INTO actor FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error(''UNAUTHENTICATED''); END IF;
  IF operation IS NULL OR operation NOT IN (''create'', ''update'', ''delete'', ''copy'', ''record'')
    OR jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string''
    OR idempotency_key IS NULL OR idempotency_key COLLATE "C" !~ ''^[!-~]{1,128}$'' OR strpos(idempotency_key, '','') > 0
    OR request_hash IS NULL OR request_hash COLLATE "C" !~ ''^[a-f0-9]{64}$'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>''workspaceId'' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;

  SELECT r.* INTO previous_request FROM meal_command_requests r
    WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id AND r.request_key = idempotency_key
      AND r.expires_at > clock_timestamp();
  IF FOUND THEN
    IF previous_request.operation = operation AND previous_request.request_hash = request_hash THEN
      RETURN previous_request.response_json;
    END IF;
    RETURN jsonb_build_object(''ok'', false, ''code'', ''IDEMPOTENCY_KEY_REUSED'', ''status'', 409,
      ''error'', ''この送信キーは別の操作または入力で使用済みです。'');
  END IF;

  IF operation = ''copy'' THEN
    target_date := mille_meal_date(payload->>''targetDate'');
    target_type := payload->>''targetMealType'';
    IF jsonb_typeof(payload->''mealId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''sourceVersion'', 1, 2147483647, 0)
      OR target_date IS NULL OR target_type IS NULL OR target_type NOT IN (''BREAKFAST'', ''LUNCH'', ''DINNER'') THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    SELECT m.* INTO source_meal FROM meals m
      WHERE m.id = payload->>''mealId'' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
    IF source_meal.version <> (payload->>''sourceVersion'')::numeric THEN
      RETURN mille_meal_error(''VERSION_CONFLICT'', source_meal.version);
    END IF;
    IF source_meal.status <> ''RECORDED'' THEN RETURN mille_meal_error(''NOT_RECORDED''); END IF;

    -- Reuse the existing create operation with a fresh snapshot that contains no child IDs.
    SELECT jsonb_agg(jsonb_build_object(
      ''name'', d.name, ''servings'', d.servings, ''recipeText'', d.recipe_text, ''recipeUrl'', d.recipe_url,
      ''ingredients'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        ''name'', i.name, ''amountText'', i.amount_text, ''unit'', i.unit
      ) ORDER BY i.position) FROM dish_ingredients i WHERE i.dish_id = d.id), ''[]''::jsonb)
    ) ORDER BY d.position) INTO copy_dishes FROM meal_dishes d WHERE d.meal_id = source_meal.id;
    result := mille_meal_command(actor.id, actor.email, ''create'', jsonb_build_object(
      ''workspaceId'', target_workspace, ''mealDate'', payload->>''targetDate'', ''mealType'', target_type,
      ''servings'', source_meal.servings, ''dishes'', copy_dishes));
  ELSE
    result := mille_meal_command(actor.id, actor.email, operation, payload);
  END IF;

  IF (result->>''ok'')::boolean THEN
    written_at := clock_timestamp();
    DELETE FROM meal_command_requests r WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id
      AND r.expires_at <= written_at;
    INSERT INTO meal_command_requests (workspace_id, actor_id, request_key, operation, request_hash, response_json, created_at, expires_at)
      VALUES (target_workspace, actor.id, idempotency_key, operation, request_hash, result, written_at, written_at + interval ''24 hours'');
  END IF;
  RETURN result;
END;
$meal_idempotent$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mille_meal_dish_search(actor_id text, actor_email text, payload jsonb)
RETURNS jsonb AS $meal_dish_search$
DECLARE
  target_workspace text;
  search_term text;
  search_pattern text;
  page_limit integer;
  after_date date;
  after_meal text;
  after_position integer;
  after_dish text;
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email))
    AND mille_meal_actor_allowed(u)) THEN
    RETURN mille_meal_error(''UNAUTHENTICATED'');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  target_workspace := payload->>''workspaceId'';
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;
  search_term := payload->>''q'';
  IF jsonb_typeof(payload->''q'') IS DISTINCT FROM ''string'' OR char_length(search_term) NOT BETWEEN 1 AND 100
    OR NOT mille_meal_number_valid(payload->''limit'', 1, 50, 0) THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  page_limit := (payload->>''limit'')::numeric::integer;
  IF payload ? ''cursor'' THEN
    after_date := mille_meal_date(payload->''cursor''->>''mealDate'');
    IF jsonb_typeof(payload->''cursor'') IS DISTINCT FROM ''object'' OR after_date IS NULL
      OR jsonb_typeof(payload->''cursor''->''mealId'') IS DISTINCT FROM ''string''
      OR jsonb_typeof(payload->''cursor''->''dishId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''cursor''->''position'', 0, 19, 0) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    after_meal := payload->''cursor''->>''mealId'';
    after_dish := payload->''cursor''->>''dishId'';
    after_position := (payload->''cursor''->>''position'')::numeric::integer;
  END IF;

  search_pattern := ''%'' || replace(replace(replace(search_term, chr(92), chr(92) || chr(92)),
    ''%'', chr(92) || ''%''), ''_'', chr(92) || ''_'') || ''%'';
  WITH page AS (
    SELECT m.meal_date, m.meal_type, m.id AS meal_id, d.id AS dish_id, d.position, d.name
    FROM meals m JOIN meal_dishes d ON d.meal_id = m.id
    WHERE m.workspace_id = target_workspace AND m.status = ''RECORDED'' AND d.name ILIKE search_pattern ESCAPE chr(92)
      AND (after_date IS NULL OR (m.meal_date, m.id) < (after_date, after_meal)
        OR (m.meal_date = after_date AND m.id = after_meal AND (d.position, d.id) > (after_position, after_dish)))
    ORDER BY m.meal_date DESC, m.id DESC, d.position, d.id
    LIMIT page_limit + 1
  ), numbered AS (
    SELECT page.*, row_number() OVER (ORDER BY meal_date DESC, meal_id DESC, position, dish_id) AS row_index FROM page
  ), encoded AS (
    SELECT row_index, jsonb_build_object(''mealDate'', to_char(meal_date, ''YYYY-MM-DD''),
      ''mealId'', meal_id, ''position'', position, ''dishId'', dish_id) AS cursor_values, meal_type, name
    FROM numbered
  )
  SELECT jsonb_build_object(
    ''items'', COALESCE(jsonb_agg(cursor_values || jsonb_build_object(''mealType'', meal_type, ''dishName'', name)
      ORDER BY row_index) FILTER (WHERE row_index <= page_limit), ''[]''::jsonb),
    ''nextCursor'', CASE WHEN count(*) > page_limit
      THEN jsonb_agg(cursor_values) FILTER (WHERE row_index = page_limit)->0 ELSE NULL END
  ) INTO result FROM encoded;
  RETURN jsonb_build_object(''ok'', true, ''data'', result);
END;
$meal_dish_search$ LANGUAGE plpgsql STABLE;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('005_meal_plans.sql','afc13b2cb48c9e3e37e0c73cae90a0ac7a3c086829e7bd502bce163f8d5cb71a');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '006_meal_suggestions.sql') THEN
    EXECUTE 'CREATE TABLE meal_suggestions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES app_users(id),
  conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions) = ''object''),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  candidates jsonb NOT NULL DEFAULT ''[]''::jsonb CHECK (jsonb_typeof(candidates) = ''array''),
  messages jsonb NOT NULL DEFAULT ''[]''::jsonb CHECK (jsonb_typeof(messages) = ''array''),
  latest_request_id text,
  UNIQUE (id, workspace_id)
);

CREATE INDEX meal_suggestions_workspace_idx ON meal_suggestions(workspace_id);

CREATE TABLE meal_suggestion_requests (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  suggestion_id text NOT NULL,
  workspace_id text NOT NULL,
  actor_id text NOT NULL REFERENCES app_users(id),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ ''^[a-f0-9]{64}$''),
  operation text NOT NULL CHECK (operation IN (''create'', ''revise'', ''adopt'')),
  status text NOT NULL CHECK (status IN (''RUNNING'', ''SUCCEEDED'', ''FAILED'', ''EXPIRED'')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  message text,
  failure text CHECK (failure IN (''TIMEOUT'', ''UNAVAILABLE'', ''INVALID_OUTPUT'')),
  provider_model text,
  prompt_version text,
  lease_until timestamptz,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (suggestion_id, workspace_id) REFERENCES meal_suggestions(id, workspace_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, actor_id, request_key)
);

ALTER TABLE meal_suggestions ADD CONSTRAINT meal_suggestions_latest_request_fk
  FOREIGN KEY (latest_request_id) REFERENCES meal_suggestion_requests(id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX meal_suggestion_requests_suggestion_idx ON meal_suggestion_requests(suggestion_id, workspace_id);

CREATE FUNCTION mille_suggestion_view(suggestion meal_suggestions, attempt meal_suggestion_requests, observed_at timestamptz)
RETURNS jsonb AS $suggestion_view$
  SELECT jsonb_build_object(
    ''id'', (suggestion).id, ''version'', (suggestion).version, ''conditions'', (suggestion).conditions,
    ''candidates'', (suggestion).candidates, ''messages'', (suggestion).messages,
    ''request'', jsonb_build_object(
      ''id'', (attempt).id, ''status'', CASE WHEN (attempt).status = ''RUNNING''
        AND (attempt).lease_until <= observed_at THEN ''EXPIRED'' ELSE (attempt).status END,
      ''failure'', (attempt).failure, ''message'', (attempt).message
    )
  );
$suggestion_view$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_suggestion_error(code text, current_version integer DEFAULT NULL)
RETURNS jsonb AS $suggestion_error$
  SELECT CASE code
    WHEN ''GENERATION_IN_PROGRESS'' THEN jsonb_build_object(
      ''ok'', false, ''status'', 409, ''code'', code, ''error'', ''献立案を作成中です。完了後にもう一度お試しください。'')
    WHEN ''VERSION_CONFLICT'' THEN jsonb_strip_nulls(jsonb_build_object(
      ''ok'', false, ''status'', 409, ''code'', code, ''currentVersion'', current_version,
      ''error'', ''献立案が更新されました。最新版を確認してください。''))
    WHEN ''IDEMPOTENCY_KEY_REUSED'' THEN jsonb_build_object(
      ''ok'', false, ''status'', 409, ''code'', code, ''error'', ''同じ送信キーに異なる入力が指定されました。'')
    ELSE mille_meal_error(code)
  END;
$suggestion_error$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_suggestion_recent_dishes(target_workspace text, target_date date)
RETURNS jsonb AS $suggestion_history$
  WITH recent_meals AS (
    SELECT m.id, m.meal_date FROM meals m
    WHERE m.workspace_id = target_workspace AND m.status = ''RECORDED''
      AND m.meal_date >= target_date - 14 AND m.meal_date < target_date
    ORDER BY m.meal_date DESC, m.id DESC
    LIMIT 42
  ), recent_dishes AS (
    SELECT d.name, m.meal_date, m.id AS meal_id, d.position
    FROM recent_meals m JOIN meal_dishes d ON d.meal_id = m.id
    ORDER BY m.meal_date DESC, m.id DESC, d.position
    LIMIT 120
  )
  SELECT COALESCE(jsonb_agg(name ORDER BY meal_date DESC, meal_id DESC, position), ''[]''::jsonb)
  FROM recent_dishes;
$suggestion_history$ LANGUAGE sql STABLE;

CREATE FUNCTION mille_suggestion_command(actor_id text, actor_email text, operation text, payload jsonb)
RETURNS jsonb AS $suggestion_command$
DECLARE
  actor app_users%ROWTYPE;
  target_workspace text := payload->>''workspaceId'';
  target_id text := payload->>''suggestionId'';
  supplied_key text := payload->>''requestKey'';
  supplied_hash text := payload->>''requestHash'';
  observed_at timestamptz;
  suggestion meal_suggestions%ROWTYPE;
  attempt meal_suggestion_requests%ROWTYPE;
  supplied_version integer;
  candidate jsonb;
  meal_payload jsonb;
  reply jsonb;
BEGIN
  -- Keep this order consistent with the workspace and meal write commands. No provider call holds these locks.
  SELECT u.* INTO actor FROM app_users u
    WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN
    RETURN mille_suggestion_error(''UNAUTHENTICATED'');
  END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = target_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_suggestion_error(''NOT_FOUND'');
  END IF;
  observed_at := clock_timestamp();

  IF operation IN (''create'', ''revise'', ''adopt'') THEN
    IF supplied_key IS NULL OR char_length(supplied_key) NOT BETWEEN 1 AND 128
      OR supplied_hash IS NULL OR supplied_hash !~ ''^[a-f0-9]{64}$'' THEN
      RETURN mille_suggestion_error(''INVALID_INPUT'');
    END IF;
    SELECT r.* INTO attempt FROM meal_suggestion_requests r
      WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id AND r.request_key = supplied_key;
    IF FOUND THEN
      IF attempt.request_hash <> supplied_hash THEN
        RETURN mille_suggestion_error(''IDEMPOTENCY_KEY_REUSED'');
      END IF;
      IF attempt.response_json IS NOT NULL THEN
        RETURN jsonb_build_object(''ok'', true, ''data'', attempt.response_json);
      END IF;
      SELECT s.* INTO STRICT suggestion FROM meal_suggestions s WHERE s.id = attempt.suggestion_id;
      RETURN jsonb_build_object(''ok'', true, ''data'', mille_suggestion_view(suggestion, attempt, observed_at));
    END IF;
  END IF;

  IF operation = ''create'' THEN
    INSERT INTO meal_suggestions(workspace_id, created_by, conditions)
      VALUES (target_workspace, actor.id, payload->''conditions'') RETURNING * INTO suggestion;
  ELSE
    SELECT s.* INTO suggestion FROM meal_suggestions s
      WHERE s.id = target_id AND s.workspace_id = target_workspace;
    IF NOT FOUND THEN RETURN mille_suggestion_error(''NOT_FOUND''); END IF;
    SELECT r.* INTO STRICT attempt FROM meal_suggestion_requests r WHERE r.id = suggestion.latest_request_id;
  END IF;

  IF operation = ''get'' THEN
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_suggestion_view(suggestion, attempt, observed_at));
  END IF;

  IF operation = ''finish'' THEN
    IF attempt.id IS DISTINCT FROM payload->>''requestId'' THEN
      SELECT r.* INTO attempt FROM meal_suggestion_requests r WHERE r.id = payload->>''requestId''
        AND r.actor_id = actor.id AND r.suggestion_id = suggestion.id;
      IF NOT FOUND THEN RETURN mille_suggestion_error(''NOT_FOUND''); END IF;
    END IF;
    IF attempt.actor_id <> actor.id THEN RETURN mille_suggestion_error(''NOT_FOUND''); END IF;
    IF attempt.response_json IS NOT NULL THEN
      RETURN jsonb_build_object(''ok'', true, ''data'', attempt.response_json);
    END IF;
    IF attempt.id <> suggestion.latest_request_id OR attempt.expected_version <> suggestion.version
      OR attempt.status <> ''RUNNING'' THEN
      RETURN mille_suggestion_error(''VERSION_CONFLICT'', suggestion.version);
    END IF;

    IF attempt.lease_until <= observed_at THEN
      attempt.status := ''EXPIRED'';
    ELSIF payload->>''failure'' IS NOT NULL THEN
      attempt.status := ''FAILED'';
      attempt.failure := payload->>''failure'';
    ELSE
      attempt.status := ''SUCCEEDED'';
      UPDATE meal_suggestions s SET
        candidates = payload->''candidates'', version = s.version + 1,
        messages = CASE WHEN attempt.message IS NULL THEN s.messages ELSE s.messages || to_jsonb(attempt.message) END
        WHERE s.id = suggestion.id RETURNING * INTO suggestion;
    END IF;
    reply := mille_suggestion_view(suggestion, attempt, observed_at);
    UPDATE meal_suggestion_requests r SET status = attempt.status, failure = attempt.failure, response_json = reply
      WHERE r.id = attempt.id;
    RETURN jsonb_build_object(''ok'', true, ''data'', reply);
  END IF;

  IF operation IN (''revise'', ''adopt'') THEN
    supplied_version := (payload->>''expectedVersion'')::integer;
    IF attempt.status = ''RUNNING'' AND attempt.lease_until > observed_at THEN
      RETURN mille_suggestion_error(''GENERATION_IN_PROGRESS'');
    END IF;
    IF supplied_version IS DISTINCT FROM suggestion.version THEN
      RETURN mille_suggestion_error(''VERSION_CONFLICT'', suggestion.version);
    END IF;
  END IF;

  IF operation = ''adopt'' THEN
    SELECT item.value INTO candidate FROM jsonb_array_elements(suggestion.candidates) AS item(value)
      WHERE item.value->>''id'' = payload->>''candidateId'';
    IF NOT FOUND THEN RETURN mille_suggestion_error(''NOT_FOUND''); END IF;
    meal_payload := jsonb_build_object(
      ''workspaceId'', target_workspace, ''mealDate'', suggestion.conditions->''mealDate'',
      ''mealType'', suggestion.conditions->''mealType'', ''servings'', suggestion.conditions->''servings'',
      ''dishes'', candidate->''dishes''
    );
    IF payload ? ''replaceVersion'' THEN
      IF payload->''confirmReplacement'' IS DISTINCT FROM ''true''::jsonb THEN
        RETURN mille_suggestion_error(''INVALID_INPUT'');
      END IF;
      meal_payload := meal_payload || jsonb_build_object(
        ''replaceMealId'', payload->''replaceMealId'', ''replaceVersion'', payload->''replaceVersion'');
    END IF;
    reply := mille_meal_adopt_plan(actor.id, actor_email, meal_payload);
    IF (reply->>''ok'')::boolean THEN
      INSERT INTO meal_suggestion_requests(
        suggestion_id, workspace_id, actor_id, request_key, request_hash, operation, status, expected_version, response_json
      ) VALUES (suggestion.id, target_workspace, actor.id, supplied_key, supplied_hash, operation, ''SUCCEEDED'',
        supplied_version, reply->''data'');
    END IF;
    RETURN reply;
  END IF;

  IF operation IN (''create'', ''revise'') THEN
    IF attempt.status = ''RUNNING'' THEN
      -- A past lease can no longer finish. Store its view before changing which request is current.
      attempt.status := ''EXPIRED'';
      UPDATE meal_suggestion_requests r SET status = attempt.status,
        response_json = mille_suggestion_view(suggestion, attempt, observed_at) WHERE r.id = attempt.id;
    END IF;
    INSERT INTO meal_suggestion_requests(
      suggestion_id, workspace_id, actor_id, request_key, request_hash, operation, status, expected_version,
      message, provider_model, prompt_version, lease_until
    ) VALUES (suggestion.id, target_workspace, actor.id, supplied_key, supplied_hash, operation, ''RUNNING'',
      suggestion.version, payload->>''message'', payload->>''providerModel'', payload->>''promptVersion'',
      observed_at + interval ''60 seconds'') RETURNING * INTO attempt;
    UPDATE meal_suggestions s SET latest_request_id = attempt.id WHERE s.id = suggestion.id;
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_suggestion_view(suggestion, attempt, observed_at),
      ''recentDishes'', mille_suggestion_recent_dishes(target_workspace, mille_meal_date(suggestion.conditions->>''mealDate'')));
  END IF;

  RETURN mille_suggestion_error(''INVALID_INPUT'');
END;
$suggestion_command$ LANGUAGE plpgsql;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('006_meal_suggestions.sql','210f984f9444211a81c2c82f120c38c3c9353b0ed7aceb42f5534a2be82cc857');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '007_suggestion_gateway_preview.sql') THEN
    EXECUTE 'CREATE TABLE mille_suggestion_gateway_preview (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  environment_id text NOT NULL CHECK (environment_id COLLATE "C" ~ ''^mille-pr-[1-9][0-9]*$''),
  source_sha text NOT NULL CHECK (source_sha COLLATE "C" ~ ''^[0-9a-f]{40}$''),
  deployment_id text NOT NULL CHECK (deployment_id COLLATE "C" ~ ''^dpl_[A-Za-z0-9]+$''),
  enabled boolean NOT NULL DEFAULT false,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 10)
);
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('007_suggestion_gateway_preview.sql','e0f6a8ea78ce0cf7d4078a503fa7cc7b0465523d8523efe2ba8fd9ea705b4f81');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '008_meal_photos.sql') THEN
    EXECUTE '-- Store only sanitized derivatives for attached images. Workspace and dish deletions
-- remove bytes, pending chunks and dependent records in the same transaction.
CREATE TABLE meal_photos (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dish_id text UNIQUE REFERENCES meal_dishes(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES app_users(id),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  source_size integer NOT NULL CHECK (source_size BETWEEN 1 AND 8388608),
  bytes bytea CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
  width integer CHECK (width BETWEEN 1 AND 1600),
  height integer CHECK (height BETWEEN 1 AND 1600),
  expires_at timestamptz,
  CHECK ((bytes IS NULL AND width IS NULL AND height IS NULL)
    OR (bytes IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL)),
  CHECK ((dish_id IS NULL AND expires_at IS NOT NULL)
    OR (dish_id IS NOT NULL AND expires_at IS NULL AND bytes IS NOT NULL))
);

CREATE INDEX meal_photos_workspace_expiry_idx ON meal_photos (workspace_id, expires_at);

CREATE TABLE meal_photo_upload_chunks (
  photo_id uuid NOT NULL REFERENCES meal_photos(id) ON DELETE CASCADE,
  chunk_index smallint NOT NULL CHECK (chunk_index BETWEEN 0 AND 7),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  PRIMARY KEY (photo_id, chunk_index)
);

CREATE FUNCTION mille_meal_photo_json(photo meal_photos) RETURNS jsonb AS $photo_json$
  SELECT jsonb_build_object(''id'', (photo).id, ''dishId'', (photo).dish_id,
    ''ready'', (photo).bytes IS NOT NULL, ''width'', (photo).width, ''height'', (photo).height);
$photo_json$ LANGUAGE sql STABLE;

CREATE FUNCTION mille_meal_photo_error(code text) RETURNS jsonb AS $photo_error$
  SELECT CASE code
    WHEN ''PHOTO_CONFLICT'' THEN jsonb_build_object(''ok'', false, ''code'', code, ''status'', 409,
      ''error'', ''写真の送信状態が変わりました。写真を確認してからやり直してください。'')
    WHEN ''PHOTO_LIMIT'' THEN jsonb_build_object(''ok'', false, ''code'', code, ''status'', 409,
      ''error'', ''保存できる写真の上限に達しました。'')
    ELSE mille_meal_error(code)
  END;
$photo_error$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_photo_read(
  actor_id text, actor_email text, operation text, target_workspace text, target_photo uuid
) RETURNS jsonb AS $photo_read$
DECLARE
  photo meal_photos%ROWTYPE;
  source bytea;
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email))
    AND mille_meal_actor_allowed(u)) THEN
    RETURN mille_meal_error(''UNAUTHENTICATED'');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;
  SELECT p.* INTO photo FROM meal_photos p
    WHERE p.id = target_photo AND p.workspace_id = target_workspace
      AND (p.dish_id IS NOT NULL OR (p.created_by = actor_id AND p.expires_at > statement_timestamp()));
  IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;

  IF operation = ''read'' THEN
    IF photo.bytes IS NULL THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
    result := to_jsonb(encode(photo.bytes, ''base64''));
  ELSIF operation = ''assemble'' THEN
    IF photo.created_by <> actor_id THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;
    IF photo.bytes IS NULL THEN
      SELECT string_agg(c.bytes, ''''::bytea ORDER BY c.chunk_index) INTO source
        FROM meal_photo_upload_chunks c WHERE c.photo_id = photo.id;
      IF octet_length(source) IS DISTINCT FROM photo.source_size THEN
        RETURN mille_meal_photo_error(''PHOTO_CONFLICT'');
      END IF;
    END IF;
    result := jsonb_build_object(''photo'', mille_meal_photo_json(photo),
      ''generation'', photo.generation, ''source'', encode(source, ''base64''));
  ELSE
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  RETURN jsonb_build_object(''ok'', true, ''data'', result);
END;
$photo_read$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION mille_meal_photo_write(
  actor_id text, actor_email text, operation text, target_workspace text, target_photo uuid, payload jsonb
) RETURNS jsonb AS $photo_write$
DECLARE
  actor app_users%ROWTYPE;
  workspace text;
  photo meal_photos%ROWTYPE;
  supplied_bytes bytea;
  previous_bytes bytea;
  upload_index integer;
BEGIN
  -- Take locks in the same order as meal and workspace writes.
  SELECT u.* INTO actor FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error(''UNAUTHENTICATED''); END IF;
  SELECT w.id INTO workspace FROM workspaces w WHERE w.id = target_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;
  IF operation IS NULL OR operation NOT IN (''create'', ''chunk'', ''finish'', ''discard'')
    OR target_photo IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM ''object'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;

  IF operation = ''create'' THEN
    IF NOT mille_meal_number_valid(payload->''size'', 1, 8388608, 0) THEN RETURN mille_meal_error(''INVALID_INPUT''); END IF;
    DELETE FROM meal_photos p WHERE p.workspace_id = workspace AND p.expires_at <= clock_timestamp();
    SELECT p.* INTO photo FROM meal_photos p WHERE p.id = target_photo AND p.workspace_id = workspace
      AND p.created_by = actor.id;
    IF FOUND THEN
      IF photo.source_size <> (payload->>''size'')::integer THEN RETURN mille_meal_photo_error(''PHOTO_CONFLICT''); END IF;
      RETURN jsonb_build_object(''ok'', true, ''data'', mille_meal_photo_json(photo));
    END IF;
    IF (SELECT count(*) FROM meal_photos p WHERE p.workspace_id = workspace AND p.dish_id IS NULL) >= 10 THEN
      RETURN mille_meal_photo_error(''PHOTO_LIMIT'');
    END IF;
    INSERT INTO meal_photos (id, workspace_id, created_by, source_size, expires_at)
      VALUES (target_photo, workspace, actor.id, (payload->>''size'')::integer, clock_timestamp() + interval ''24 hours'')
      ON CONFLICT (id) DO NOTHING RETURNING * INTO photo;
    IF NOT FOUND THEN RETURN mille_meal_photo_error(''PHOTO_CONFLICT''); END IF;
    RETURN jsonb_build_object(''ok'', true, ''data'', mille_meal_photo_json(photo));
  END IF;

  SELECT p.* INTO photo FROM meal_photos p
    WHERE p.id = target_photo AND p.workspace_id = workspace AND p.created_by = actor.id
      AND (p.dish_id IS NOT NULL OR p.expires_at > clock_timestamp());
  IF operation = ''discard'' THEN
    -- A late cleanup can only remove the generation that it intended to remove.
    IF FOUND AND photo.dish_id IS NULL
      AND (NOT (payload ? ''generation'')
        OR (photo.generation::text = payload->>''generation'' AND photo.bytes IS NULL)) THEN
      DELETE FROM meal_photos p WHERE p.id = photo.id;
    END IF;
    RETURN jsonb_build_object(''ok'', true, ''data'', NULL);
  END IF;
  IF NOT FOUND THEN RETURN mille_meal_error(''NOT_FOUND''); END IF;

  IF operation = ''chunk'' THEN
    IF photo.bytes IS NOT NULL THEN RETURN mille_meal_photo_error(''PHOTO_CONFLICT''); END IF;
    IF NOT mille_meal_number_valid(payload->''index'', 0, 7, 0)
      OR jsonb_typeof(payload->''bytes'') IS DISTINCT FROM ''string''
      OR char_length(payload->>''bytes'') > 1398104 THEN RETURN mille_meal_error(''INVALID_INPUT''); END IF;
    upload_index := (payload->>''index'')::integer;
    supplied_bytes := decode(payload->>''bytes'', ''base64'');
    IF upload_index * 1048576 >= photo.source_size
      OR octet_length(supplied_bytes) <> least(1048576, photo.source_size - upload_index * 1048576) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    SELECT c.bytes INTO previous_bytes FROM meal_photo_upload_chunks c
      WHERE c.photo_id = photo.id AND c.chunk_index = upload_index;
    IF FOUND THEN
      IF previous_bytes IS DISTINCT FROM supplied_bytes THEN RETURN mille_meal_photo_error(''PHOTO_CONFLICT''); END IF;
    ELSE
      INSERT INTO meal_photo_upload_chunks (photo_id, chunk_index, bytes) VALUES (photo.id, upload_index, supplied_bytes);
    END IF;
    RETURN jsonb_build_object(''ok'', true, ''data'', NULL);
  END IF;

  IF photo.generation::text IS DISTINCT FROM payload->>''generation'' THEN
    RETURN mille_meal_photo_error(''PHOTO_CONFLICT'');
  END IF;
  IF photo.bytes IS NOT NULL THEN RETURN jsonb_build_object(''ok'', true, ''data'', mille_meal_photo_json(photo)); END IF;
  IF NOT mille_meal_number_valid(payload->''width'', 1, 1600, 0)
    OR NOT mille_meal_number_valid(payload->''height'', 1, 1600, 0)
    OR jsonb_typeof(payload->''bytes'') IS DISTINCT FROM ''string'' OR char_length(payload->>''bytes'') > 2796204 THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  supplied_bytes := decode(payload->>''bytes'', ''base64'');
  IF octet_length(supplied_bytes) NOT BETWEEN 12 AND 2097152
    OR substring(supplied_bytes FROM 1 FOR 4) <> ''RIFF''::bytea
    OR substring(supplied_bytes FROM 9 FOR 4) <> ''WEBP''::bytea THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  UPDATE meal_photos p SET bytes = supplied_bytes, width = (payload->>''width'')::integer, height = (payload->>''height'')::integer
    WHERE p.id = photo.id RETURNING * INTO photo;
  DELETE FROM meal_photo_upload_chunks c WHERE c.photo_id = photo.id;
  RETURN jsonb_build_object(''ok'', true, ''data'', mille_meal_photo_json(photo));
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
  RETURN mille_meal_error(''INVALID_INPUT'');
END;
$photo_write$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mille_meal_json(meal meals, include_details boolean) RETURNS jsonb AS $meal_json$
  SELECT jsonb_build_object(
    ''id'', (meal).id, ''workspaceId'', (meal).workspace_id, ''mealDate'', to_char((meal).meal_date, ''YYYY-MM-DD''),
    ''mealType'', (meal).meal_type, ''status'', (meal).status, ''servings'', (meal).servings, ''version'', (meal).version,
    ''updatedBy'', jsonb_build_object(''id'', updater.id, ''name'', updater.name),
    ''updatedAt'', to_char((meal).updated_at AT TIME ZONE ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"''),
    ''dishes'', COALESCE((SELECT jsonb_agg(
      jsonb_build_object(''id'', d.id, ''position'', d.position, ''name'', d.name)
      || CASE WHEN include_details THEN jsonb_build_object(
        ''servings'', d.servings, ''recipeText'', d.recipe_text, ''recipeUrl'', d.recipe_url,
        ''ingredients'', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          ''id'', i.id, ''name'', i.name, ''amountText'', i.amount_text, ''unit'', i.unit
        ) ORDER BY i.position) FROM dish_ingredients i WHERE i.dish_id = d.id), ''[]''::jsonb)
      ) || COALESCE((SELECT jsonb_build_object(''photoId'', p.id) FROM meal_photos p WHERE p.dish_id = d.id), ''{}''::jsonb)
      ELSE ''{}''::jsonb END ORDER BY d.position)
      FROM meal_dishes d WHERE d.meal_id = (meal).id), ''[]''::jsonb)
  ) FROM app_users updater WHERE updater.id = (meal).updated_by;
$meal_json$ LANGUAGE sql STABLE;

ALTER FUNCTION mille_meal_command(text, text, text, jsonb) RENAME TO mille_meal_command_without_photos;

CREATE FUNCTION mille_meal_command(actor_id text, actor_email text, operation text, payload jsonb)
RETURNS jsonb AS $meal_with_photos$
DECLARE
  result jsonb;
  dish record;
  saved_dish text;
  requested_photo uuid;
  photo meal_photos%ROWTYPE;
  workspace text;
  photo_error text;
  photo_error_message text;
BEGIN
  IF operation IS NULL OR operation NOT IN (''create'', ''record'', ''update'')
    OR jsonb_typeof(payload->''dishes'') IS DISTINCT FROM ''array'' THEN
    RETURN mille_meal_command_without_photos(actor_id, actor_email, operation, payload);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(payload->''dishes'') AS d(value) WHERE d.value ? ''photoId'') THEN
    RETURN mille_meal_command_without_photos(actor_id, actor_email, operation, payload);
  END IF;

  -- A binding failure rolls back both the underlying meal write and every photo change.
  -- The caller records the finalized result for idempotent replays only after this returns.
  BEGIN
    result := mille_meal_command_without_photos(actor_id, actor_email, operation, payload);
    IF NOT (result->>''ok'')::boolean THEN RETURN result; END IF;
    workspace := result->''data''->>''workspaceId'';

    FOR dish IN SELECT value, ordinality::integer - 1 AS position
      FROM jsonb_array_elements(payload->''dishes'') WITH ORDINALITY
      WHERE value ? ''photoId'' LOOP
      saved_dish := result->''data''->''dishes''->dish.position->>''id'';
      IF dish.value->''photoId'' = ''null''::jsonb THEN
        DELETE FROM meal_photos p WHERE p.dish_id = saved_dish;
        CONTINUE;
      END IF;
      IF jsonb_typeof(dish.value->''photoId'') IS DISTINCT FROM ''string''
        OR (dish.value->>''photoId'') COLLATE "C" !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'' THEN
        photo_error := ''INVALID_INPUT'';
        RAISE SQLSTATE ''P0878'';
      END IF;
      requested_photo := (dish.value->>''photoId'')::uuid;
      SELECT p.* INTO photo FROM meal_photos p
        WHERE p.id = requested_photo AND p.workspace_id = workspace AND p.bytes IS NOT NULL
          AND (p.dish_id = saved_dish OR (p.dish_id IS NULL AND p.created_by = actor_id AND p.expires_at > clock_timestamp()));
      IF NOT FOUND THEN
        photo_error := ''NOT_FOUND'';
        photo_error_message := ''添付する写真が見つかりません。写真を選び直してください。'';
        RAISE SQLSTATE ''P0878'';
      END IF;
      IF photo.dish_id = saved_dish THEN CONTINUE; END IF;
      DELETE FROM meal_photos p WHERE p.dish_id = saved_dish;
      UPDATE meal_photos p SET dish_id = saved_dish, expires_at = NULL WHERE p.id = requested_photo;
    END LOOP;
    IF (SELECT count(*) FROM meal_photos p WHERE p.workspace_id = workspace AND p.dish_id IS NOT NULL) > 200 THEN
      photo_error := ''INVALID_INPUT'';
      photo_error_message := ''保存できる写真の上限に達しました。'';
      RAISE SQLSTATE ''P0878'';
    END IF;
    SELECT jsonb_build_object(''ok'', true, ''data'', mille_meal_json(m, true)) INTO result
      FROM meals m WHERE m.id = result->''data''->>''id'' AND m.workspace_id = workspace;
    RETURN result;
  EXCEPTION WHEN SQLSTATE ''P0878'' THEN
    RETURN mille_meal_error(photo_error) || jsonb_strip_nulls(jsonb_build_object(''error'', photo_error_message));
  END;
END;
$meal_with_photos$ LANGUAGE plpgsql;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('008_meal_photos.sql','2d30b3a6437a0fe758491c578857ce678f3c243056c751b7185234a7497ab6b6');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '009_meal_ingredient_search.sql') THEN
    EXECUTE '-- Add recorded ingredient names to the existing dish search contract.
CREATE OR REPLACE FUNCTION mille_meal_dish_search(actor_id text, actor_email text, payload jsonb)
RETURNS jsonb AS $meal_dish_search$
DECLARE
  target_workspace text;
  search_term text;
  search_by text;
  search_pattern text;
  page_limit integer;
  after_date date;
  after_meal text;
  after_position integer;
  after_dish text;
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email))
    AND mille_meal_actor_allowed(u)) THEN
    RETURN mille_meal_error(''UNAUTHENTICATED'');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM ''object'' OR jsonb_typeof(payload->''workspaceId'') IS DISTINCT FROM ''string'' THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  target_workspace := payload->>''workspaceId'';
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error(''NOT_FOUND'');
  END IF;
  search_term := payload->>''q'';
  search_by := COALESCE(payload->>''by'', ''name'');
  IF payload ? ''by'' AND (jsonb_typeof(payload->''by'') IS DISTINCT FROM ''string''
    OR search_by NOT IN (''name'', ''ingredient'')) THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  IF jsonb_typeof(payload->''q'') IS DISTINCT FROM ''string'' OR char_length(search_term) NOT BETWEEN 1 AND 100
    OR NOT mille_meal_number_valid(payload->''limit'', 1, 50, 0) THEN
    RETURN mille_meal_error(''INVALID_INPUT'');
  END IF;
  page_limit := (payload->>''limit'')::numeric::integer;
  IF payload ? ''cursor'' THEN
    after_date := mille_meal_date(payload->''cursor''->>''mealDate'');
    IF jsonb_typeof(payload->''cursor'') IS DISTINCT FROM ''object'' OR after_date IS NULL
      OR jsonb_typeof(payload->''cursor''->''mealId'') IS DISTINCT FROM ''string''
      OR jsonb_typeof(payload->''cursor''->''dishId'') IS DISTINCT FROM ''string''
      OR NOT mille_meal_number_valid(payload->''cursor''->''position'', 0, 19, 0) THEN
      RETURN mille_meal_error(''INVALID_INPUT'');
    END IF;
    after_meal := payload->''cursor''->>''mealId'';
    after_dish := payload->''cursor''->>''dishId'';
    after_position := (payload->''cursor''->>''position'')::numeric::integer;
  END IF;

  search_pattern := ''%'' || replace(replace(replace(search_term, chr(92), chr(92) || chr(92)),
    ''%'', chr(92) || ''%''), ''_'', chr(92) || ''_'') || ''%'';
  WITH page AS (
    SELECT m.meal_date, m.meal_type, m.id AS meal_id, d.id AS dish_id, d.position, d.name
    FROM meals m JOIN meal_dishes d ON d.meal_id = m.id
    WHERE m.workspace_id = target_workspace AND m.status = ''RECORDED''
      AND CASE WHEN search_by = ''ingredient'' THEN EXISTS (
        SELECT 1 FROM dish_ingredients i WHERE i.dish_id = d.id
          AND i.name ILIKE search_pattern ESCAPE chr(92)
      ) ELSE d.name ILIKE search_pattern ESCAPE chr(92) END
      AND (after_date IS NULL OR (m.meal_date, m.id) < (after_date, after_meal)
        OR (m.meal_date = after_date AND m.id = after_meal AND (d.position, d.id) > (after_position, after_dish)))
    ORDER BY m.meal_date DESC, m.id DESC, d.position, d.id
    LIMIT page_limit + 1
  ), numbered AS (
    SELECT page.*, row_number() OVER (ORDER BY meal_date DESC, meal_id DESC, position, dish_id) AS row_index FROM page
  ), encoded AS (
    SELECT row_index, jsonb_build_object(''mealDate'', to_char(meal_date, ''YYYY-MM-DD''),
      ''mealId'', meal_id, ''position'', position, ''dishId'', dish_id) AS cursor_values, meal_type, name
    FROM numbered
  )
  SELECT jsonb_build_object(
    ''items'', COALESCE(jsonb_agg(cursor_values || jsonb_build_object(''mealType'', meal_type, ''dishName'', name)
      ORDER BY row_index) FILTER (WHERE row_index <= page_limit), ''[]''::jsonb),
    ''nextCursor'', CASE WHEN count(*) > page_limit
      THEN jsonb_agg(cursor_values) FILTER (WHERE row_index = page_limit)->0 ELSE NULL END
  ) INTO result FROM encoded;
  RETURN jsonb_build_object(''ok'', true, ''data'', result);
END;
$meal_dish_search$ LANGUAGE plpgsql STABLE;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('009_meal_ingredient_search.sql','b85f5eecb705ddaa490bebd249301a5ed99aa35461005eb59287853caf40b0d4');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '010_meal_photo_analysis.sql') THEN
    EXECUTE 'CREATE TABLE meal_photo_analyses (
  photo_id uuid NOT NULL REFERENCES meal_photos(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (model IN (''sample'', ''gpt-6-luna'')),
  prompt_version text NOT NULL,
  image_sha256 text NOT NULL CHECK (image_sha256 ~ ''^[0-9a-f]{64}$''),
  meal_version integer,
  lease uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = ''object''),
  PRIMARY KEY (photo_id, model, prompt_version)
);

CREATE TABLE mille_meal_photo_preview (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  environment_id text NOT NULL CHECK (environment_id ~ ''^mille-pr-[1-9][0-9]*$''),
  source_sha text NOT NULL CHECK (source_sha ~ ''^[0-9a-f]{40}$''),
  deployment_id text NOT NULL CHECK (deployment_id ~ ''^dpl_[A-Za-z0-9]+$''),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 10)
);

CREATE FUNCTION mille_meal_photo_analysis(actor_id text, actor_email text, operation text,
  target_workspace text, target_photo uuid, target_model text, target_prompt text,
  target_lease uuid, payload jsonb)
RETURNS jsonb AS $analysis$
DECLARE
  actor app_users%ROWTYPE;
  photo meal_photos%ROWTYPE;
  job meal_photo_analyses%ROWTYPE;
BEGIN
  SELECT u.* INTO actor FROM app_users u WHERE u.id = actor_id AND u.email = lower(btrim(actor_email)) FOR UPDATE;
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN
    RETURN jsonb_build_object(''status'', ''unauthenticated'');
  END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = target_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspace_members w WHERE w.workspace_id = target_workspace AND w.user_id = actor_id
  ) THEN
    RETURN jsonb_build_object(''status'', ''missing'');
  END IF;
  SELECT p.* INTO photo FROM meal_photos p
    WHERE p.id = target_photo AND p.workspace_id = target_workspace AND p.bytes IS NOT NULL
      AND (p.dish_id IS NOT NULL OR (p.created_by = actor_id AND p.expires_at > clock_timestamp()))
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object(''status'', ''missing''); END IF;
  SELECT a.* INTO job FROM meal_photo_analyses a
    WHERE a.photo_id = target_photo AND a.model = target_model AND a.prompt_version = target_prompt;

  IF operation = ''start'' THEN
    IF encode(sha256(photo.bytes), ''hex'') IS DISTINCT FROM payload->>''imageSha256'' THEN
      RETURN jsonb_build_object(''status'', ''missing'');
    END IF;
    IF job.result IS NOT NULL THEN RETURN jsonb_build_object(''status'', ''ready'', ''result'', job.result); END IF;
    IF job.lease_expires_at > clock_timestamp() THEN RETURN jsonb_build_object(''status'', ''pending''); END IF;
    IF target_model = ''gpt-6-luna'' THEN
      UPDATE mille_meal_photo_preview SET request_count = request_count + 1
        WHERE id AND enabled AND environment_id = payload->>''environmentId''
          AND source_sha = payload->>''sourceSha'' AND deployment_id = payload->>''deploymentId''
          AND request_count < 10;
      IF NOT FOUND THEN RETURN jsonb_build_object(''status'', ''limited''); END IF;
    END IF;
    INSERT INTO meal_photo_analyses (photo_id, model, prompt_version, image_sha256, meal_version, lease, lease_expires_at)
      VALUES (target_photo, target_model, target_prompt, payload->>''imageSha256'',
        (SELECT m.version FROM meal_dishes d JOIN meals m ON m.id = d.meal_id WHERE d.id = photo.dish_id),
        target_lease, clock_timestamp() + interval ''45 seconds'')
      ON CONFLICT (photo_id, model, prompt_version) DO UPDATE SET image_sha256 = EXCLUDED.image_sha256,
        meal_version = EXCLUDED.meal_version, lease = EXCLUDED.lease, lease_expires_at = EXCLUDED.lease_expires_at;
    RETURN jsonb_build_object(''status'', ''started'');
  END IF;

  IF job.lease IS DISTINCT FROM target_lease OR job.result IS NOT NULL
    OR job.lease_expires_at <= clock_timestamp() THEN RETURN jsonb_build_object(''status'', ''pending''); END IF;
  IF operation = ''finish'' THEN
    UPDATE meal_photo_analyses a SET result = payload
      WHERE a.photo_id = target_photo AND a.model = target_model AND a.prompt_version = target_prompt;
    RETURN jsonb_build_object(''status'', ''ready'', ''result'', payload);
  END IF;
  IF operation = ''fail'' THEN
    DELETE FROM meal_photo_analyses a
      WHERE a.photo_id = target_photo AND a.model = target_model AND a.prompt_version = target_prompt;
    RETURN jsonb_build_object(''status'', ''released'');
  END IF;
  RAISE EXCEPTION ''Unknown meal photo analysis operation'';
END;
$analysis$ LANGUAGE plpgsql;
';
    INSERT INTO schema_migrations (name,sha256) VALUES ('010_meal_photo_analysis.sql','2f9be918b94291dfba67679aac29f405cdfd570fdad2118ae8dee903b0b915ce');
  END IF;
END; $mille_migration$;

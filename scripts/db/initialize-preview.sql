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
      VALUES (true,'tyask/mille','preview','mille-preview');
    CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations (name,sha256) VALUES ('001_auth.sql','83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.mille_environment WHERE singleton = true
    AND project = 'tyask/mille' AND environment = 'preview'
    AND environment_id = 'mille-preview') THEN
      RAISE EXCEPTION 'Mille database environment mismatch';
    END IF;
    IF to_regclass('public.schema_migrations') IS NULL OR NOT EXISTS
      (SELECT 1 FROM schema_migrations WHERE name = '001_auth.sql' AND sha256 = '83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126') THEN
      RAISE EXCEPTION 'Mille migration history or checksum mismatch';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name NOT IN ('001_auth.sql', '002_workspaces.sql')) THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '001_auth.sql' AND sha256 <> '83d6209b267f389e166ad3b5364420f5bbb3c3a6ada1e2c549c144bdb4ce0126') THEN
    RAISE EXCEPTION 'Mille migration history or checksum mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '002_workspaces.sql' AND sha256 <> '8ea6f940c097035d2c0e54417b60473b449219702f3aa232c24969c522c12eba') THEN
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
END; $mille_migration$;

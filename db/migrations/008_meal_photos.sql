-- Store only sanitized derivatives for attached images. Workspace and dish deletions
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
  SELECT jsonb_build_object('id', (photo).id, 'dishId', (photo).dish_id,
    'ready', (photo).bytes IS NOT NULL, 'width', (photo).width, 'height', (photo).height);
$photo_json$ LANGUAGE sql STABLE;

CREATE FUNCTION mille_meal_photo_error(code text) RETURNS jsonb AS $photo_error$
  SELECT CASE code
    WHEN 'PHOTO_CONFLICT' THEN jsonb_build_object('ok', false, 'code', code, 'status', 409,
      'error', '写真の送信状態が変わりました。写真を確認してからやり直してください。')
    WHEN 'PHOTO_LIMIT' THEN jsonb_build_object('ok', false, 'code', code, 'status', 409,
      'error', '保存できる写真の上限に達しました。')
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
    RETURN mille_meal_error('UNAUTHENTICATED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;
  SELECT p.* INTO photo FROM meal_photos p
    WHERE p.id = target_photo AND p.workspace_id = target_workspace
      AND (p.dish_id IS NOT NULL OR (p.created_by = actor_id AND p.expires_at > statement_timestamp()));
  IF NOT FOUND THEN RETURN mille_meal_error('NOT_FOUND'); END IF;

  IF operation = 'read' THEN
    IF photo.bytes IS NULL THEN RETURN mille_meal_error('NOT_FOUND'); END IF;
    result := to_jsonb(encode(photo.bytes, 'base64'));
  ELSIF operation = 'assemble' THEN
    IF photo.created_by <> actor_id THEN RETURN mille_meal_error('NOT_FOUND'); END IF;
    IF photo.bytes IS NULL THEN
      SELECT string_agg(c.bytes, ''::bytea ORDER BY c.chunk_index) INTO source
        FROM meal_photo_upload_chunks c WHERE c.photo_id = photo.id;
      IF octet_length(source) IS DISTINCT FROM photo.source_size THEN
        RETURN mille_meal_photo_error('PHOTO_CONFLICT');
      END IF;
    END IF;
    result := jsonb_build_object('photo', mille_meal_photo_json(photo),
      'generation', photo.generation, 'source', encode(source, 'base64'));
  ELSE
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  RETURN jsonb_build_object('ok', true, 'data', result);
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
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error('UNAUTHENTICATED'); END IF;
  SELECT w.id INTO workspace FROM workspaces w WHERE w.id = target_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;
  IF operation IS NULL OR operation NOT IN ('create', 'chunk', 'finish', 'discard')
    OR target_photo IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;

  IF operation = 'create' THEN
    IF NOT mille_meal_number_valid(payload->'size', 1, 8388608, 0) THEN RETURN mille_meal_error('INVALID_INPUT'); END IF;
    DELETE FROM meal_photos p WHERE p.workspace_id = workspace AND p.expires_at <= clock_timestamp();
    SELECT p.* INTO photo FROM meal_photos p WHERE p.id = target_photo AND p.workspace_id = workspace
      AND p.created_by = actor.id;
    IF FOUND THEN
      IF photo.source_size <> (payload->>'size')::integer THEN RETURN mille_meal_photo_error('PHOTO_CONFLICT'); END IF;
      RETURN jsonb_build_object('ok', true, 'data', mille_meal_photo_json(photo));
    END IF;
    IF (SELECT count(*) FROM meal_photos p WHERE p.workspace_id = workspace AND p.dish_id IS NULL) >= 10 THEN
      RETURN mille_meal_photo_error('PHOTO_LIMIT');
    END IF;
    INSERT INTO meal_photos (id, workspace_id, created_by, source_size, expires_at)
      VALUES (target_photo, workspace, actor.id, (payload->>'size')::integer, clock_timestamp() + interval '24 hours')
      ON CONFLICT (id) DO NOTHING RETURNING * INTO photo;
    IF NOT FOUND THEN RETURN mille_meal_photo_error('PHOTO_CONFLICT'); END IF;
    RETURN jsonb_build_object('ok', true, 'data', mille_meal_photo_json(photo));
  END IF;

  SELECT p.* INTO photo FROM meal_photos p
    WHERE p.id = target_photo AND p.workspace_id = workspace AND p.created_by = actor.id
      AND (p.dish_id IS NOT NULL OR p.expires_at > clock_timestamp());
  IF operation = 'discard' THEN
    -- A late cleanup can only remove the generation that it intended to remove.
    IF FOUND AND photo.dish_id IS NULL
      AND (NOT (payload ? 'generation')
        OR (photo.generation::text = payload->>'generation' AND photo.bytes IS NULL)) THEN
      DELETE FROM meal_photos p WHERE p.id = photo.id;
    END IF;
    RETURN jsonb_build_object('ok', true, 'data', NULL);
  END IF;
  IF NOT FOUND THEN RETURN mille_meal_error('NOT_FOUND'); END IF;

  IF operation = 'chunk' THEN
    IF photo.bytes IS NOT NULL THEN RETURN mille_meal_photo_error('PHOTO_CONFLICT'); END IF;
    IF NOT mille_meal_number_valid(payload->'index', 0, 7, 0)
      OR jsonb_typeof(payload->'bytes') IS DISTINCT FROM 'string'
      OR char_length(payload->>'bytes') > 1398104 THEN RETURN mille_meal_error('INVALID_INPUT'); END IF;
    upload_index := (payload->>'index')::integer;
    supplied_bytes := decode(payload->>'bytes', 'base64');
    IF upload_index * 1048576 >= photo.source_size
      OR octet_length(supplied_bytes) <> least(1048576, photo.source_size - upload_index * 1048576) THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
    SELECT c.bytes INTO previous_bytes FROM meal_photo_upload_chunks c
      WHERE c.photo_id = photo.id AND c.chunk_index = upload_index;
    IF FOUND THEN
      IF previous_bytes IS DISTINCT FROM supplied_bytes THEN RETURN mille_meal_photo_error('PHOTO_CONFLICT'); END IF;
    ELSE
      INSERT INTO meal_photo_upload_chunks (photo_id, chunk_index, bytes) VALUES (photo.id, upload_index, supplied_bytes);
    END IF;
    RETURN jsonb_build_object('ok', true, 'data', NULL);
  END IF;

  IF photo.generation::text IS DISTINCT FROM payload->>'generation' THEN
    RETURN mille_meal_photo_error('PHOTO_CONFLICT');
  END IF;
  IF photo.bytes IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'data', mille_meal_photo_json(photo)); END IF;
  IF NOT mille_meal_number_valid(payload->'width', 1, 1600, 0)
    OR NOT mille_meal_number_valid(payload->'height', 1, 1600, 0)
    OR jsonb_typeof(payload->'bytes') IS DISTINCT FROM 'string' OR char_length(payload->>'bytes') > 2796204 THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  supplied_bytes := decode(payload->>'bytes', 'base64');
  IF octet_length(supplied_bytes) NOT BETWEEN 12 AND 2097152
    OR substring(supplied_bytes FROM 1 FOR 4) <> 'RIFF'::bytea
    OR substring(supplied_bytes FROM 9 FOR 4) <> 'WEBP'::bytea THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  UPDATE meal_photos p SET bytes = supplied_bytes, width = (payload->>'width')::integer, height = (payload->>'height')::integer
    WHERE p.id = photo.id RETURNING * INTO photo;
  DELETE FROM meal_photo_upload_chunks c WHERE c.photo_id = photo.id;
  RETURN jsonb_build_object('ok', true, 'data', mille_meal_photo_json(photo));
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
  RETURN mille_meal_error('INVALID_INPUT');
END;
$photo_write$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mille_meal_json(meal meals, include_details boolean) RETURNS jsonb AS $meal_json$
  SELECT jsonb_build_object(
    'id', (meal).id, 'workspaceId', (meal).workspace_id, 'mealDate', to_char((meal).meal_date, 'YYYY-MM-DD'),
    'mealType', (meal).meal_type, 'status', (meal).status, 'servings', (meal).servings, 'version', (meal).version,
    'updatedBy', jsonb_build_object('id', updater.id, 'name', updater.name),
    'updatedAt', to_char((meal).updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dishes', COALESCE((SELECT jsonb_agg(
      jsonb_build_object('id', d.id, 'position', d.position, 'name', d.name)
      || CASE WHEN include_details THEN jsonb_build_object(
        'servings', d.servings, 'recipeText', d.recipe_text, 'recipeUrl', d.recipe_url,
        'ingredients', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', i.id, 'name', i.name, 'amountText', i.amount_text, 'unit', i.unit
        ) ORDER BY i.position) FROM dish_ingredients i WHERE i.dish_id = d.id), '[]'::jsonb)
      ) || COALESCE((SELECT jsonb_build_object('photoId', p.id) FROM meal_photos p WHERE p.dish_id = d.id), '{}'::jsonb)
      ELSE '{}'::jsonb END ORDER BY d.position)
      FROM meal_dishes d WHERE d.meal_id = (meal).id), '[]'::jsonb)
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
  IF operation IS NULL OR operation NOT IN ('create', 'record', 'update')
    OR jsonb_typeof(payload->'dishes') IS DISTINCT FROM 'array' THEN
    RETURN mille_meal_command_without_photos(actor_id, actor_email, operation, payload);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'dishes') AS d(value) WHERE d.value ? 'photoId') THEN
    RETURN mille_meal_command_without_photos(actor_id, actor_email, operation, payload);
  END IF;

  -- A binding failure rolls back both the underlying meal write and every photo change.
  -- The caller records the finalized result for idempotent replays only after this returns.
  BEGIN
    result := mille_meal_command_without_photos(actor_id, actor_email, operation, payload);
    IF NOT (result->>'ok')::boolean THEN RETURN result; END IF;
    workspace := result->'data'->>'workspaceId';

    FOR dish IN SELECT value, ordinality::integer - 1 AS position
      FROM jsonb_array_elements(payload->'dishes') WITH ORDINALITY
      WHERE value ? 'photoId' LOOP
      saved_dish := result->'data'->'dishes'->dish.position->>'id';
      IF dish.value->'photoId' = 'null'::jsonb THEN
        DELETE FROM meal_photos p WHERE p.dish_id = saved_dish;
        CONTINUE;
      END IF;
      IF jsonb_typeof(dish.value->'photoId') IS DISTINCT FROM 'string'
        OR (dish.value->>'photoId') COLLATE "C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        photo_error := 'INVALID_INPUT';
        RAISE SQLSTATE 'P0878';
      END IF;
      requested_photo := (dish.value->>'photoId')::uuid;
      SELECT p.* INTO photo FROM meal_photos p
        WHERE p.id = requested_photo AND p.workspace_id = workspace AND p.bytes IS NOT NULL
          AND (p.dish_id = saved_dish OR (p.dish_id IS NULL AND p.created_by = actor_id AND p.expires_at > clock_timestamp()));
      IF NOT FOUND THEN
        photo_error := 'NOT_FOUND';
        photo_error_message := '添付する写真が見つかりません。写真を選び直してください。';
        RAISE SQLSTATE 'P0878';
      END IF;
      IF photo.dish_id = saved_dish THEN CONTINUE; END IF;
      DELETE FROM meal_photos p WHERE p.dish_id = saved_dish;
      UPDATE meal_photos p SET dish_id = saved_dish, expires_at = NULL WHERE p.id = requested_photo;
    END LOOP;
    IF (SELECT count(*) FROM meal_photos p WHERE p.workspace_id = workspace AND p.dish_id IS NOT NULL) > 200 THEN
      photo_error := 'INVALID_INPUT';
      photo_error_message := '保存できる写真の上限に達しました。';
      RAISE SQLSTATE 'P0878';
    END IF;
    SELECT jsonb_build_object('ok', true, 'data', mille_meal_json(m, true)) INTO result
      FROM meals m WHERE m.id = result->'data'->>'id' AND m.workspace_id = workspace;
    RETURN result;
  EXCEPTION WHEN SQLSTATE 'P0878' THEN
    RETURN mille_meal_error(photo_error) || jsonb_strip_nulls(jsonb_build_object('error', photo_error_message));
  END;
END;
$meal_with_photos$ LANGUAGE plpgsql;

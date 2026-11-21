CREATE TABLE meal_command_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES app_users(id),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 128),
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'copy')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
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
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error('UNAUTHENTICATED'); END IF;
  IF operation IS NULL OR operation NOT IN ('create', 'update', 'delete', 'copy')
    OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'workspaceId') IS DISTINCT FROM 'string'
    OR idempotency_key IS NULL OR idempotency_key COLLATE "C" !~ '^[!-~]{1,128}$' OR strpos(idempotency_key, ',') > 0
    OR request_hash IS NULL OR request_hash COLLATE "C" !~ '^[a-f0-9]{64}$' THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>'workspaceId' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;

  SELECT r.* INTO previous_request FROM meal_command_requests r
    WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id AND r.request_key = idempotency_key
      AND r.expires_at > clock_timestamp();
  IF FOUND THEN
    IF previous_request.operation = operation AND previous_request.request_hash = request_hash THEN
      RETURN previous_request.response_json;
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_REUSED', 'status', 409,
      'error', 'この送信キーは別の操作または入力で使用済みです。');
  END IF;

  IF operation = 'copy' THEN
    target_date := mille_meal_date(payload->>'targetDate');
    target_type := payload->>'targetMealType';
    IF jsonb_typeof(payload->'mealId') IS DISTINCT FROM 'string'
      OR NOT mille_meal_number_valid(payload->'sourceVersion', 1, 2147483647, 0)
      OR target_date IS NULL OR target_type IS NULL OR target_type NOT IN ('BREAKFAST', 'LUNCH', 'DINNER') THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
    SELECT m.* INTO source_meal FROM meals m
      WHERE m.id = payload->>'mealId' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error('NOT_FOUND'); END IF;
    IF source_meal.version <> (payload->>'sourceVersion')::numeric THEN
      RETURN mille_meal_error('VERSION_CONFLICT', source_meal.version);
    END IF;

    -- Reuse the existing create operation with a fresh snapshot that contains no child IDs.
    SELECT jsonb_agg(jsonb_build_object(
      'name', d.name, 'servings', d.servings, 'recipeText', d.recipe_text, 'recipeUrl', d.recipe_url,
      'ingredients', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', i.name, 'amountText', i.amount_text, 'unit', i.unit
      ) ORDER BY i.position) FROM dish_ingredients i WHERE i.dish_id = d.id), '[]'::jsonb)
    ) ORDER BY d.position) INTO copy_dishes FROM meal_dishes d WHERE d.meal_id = source_meal.id;
    result := mille_meal_command(actor.id, actor.email, 'create', jsonb_build_object(
      'workspaceId', target_workspace, 'mealDate', payload->>'targetDate', 'mealType', target_type,
      'servings', source_meal.servings, 'dishes', copy_dishes));
  ELSE
    result := mille_meal_command(actor.id, actor.email, operation, payload);
  END IF;

  IF (result->>'ok')::boolean THEN
    written_at := clock_timestamp();
    DELETE FROM meal_command_requests r WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id
      AND r.expires_at <= written_at;
    INSERT INTO meal_command_requests (workspace_id, actor_id, request_key, operation, request_hash, response_json, created_at, expires_at)
      VALUES (target_workspace, actor.id, idempotency_key, operation, request_hash, result, written_at, written_at + interval '24 hours');
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
    RETURN mille_meal_error('UNAUTHENTICATED');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'workspaceId') IS DISTINCT FROM 'string' THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  target_workspace := payload->>'workspaceId';
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;
  search_term := payload->>'q';
  IF jsonb_typeof(payload->'q') IS DISTINCT FROM 'string' OR char_length(search_term) NOT BETWEEN 1 AND 100
    OR NOT mille_meal_number_valid(payload->'limit', 1, 50, 0) THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  page_limit := (payload->>'limit')::numeric::integer;
  IF payload ? 'cursor' THEN
    after_date := mille_meal_date(payload->'cursor'->>'mealDate');
    IF jsonb_typeof(payload->'cursor') IS DISTINCT FROM 'object' OR after_date IS NULL
      OR jsonb_typeof(payload->'cursor'->'mealId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(payload->'cursor'->'dishId') IS DISTINCT FROM 'string'
      OR NOT mille_meal_number_valid(payload->'cursor'->'position', 0, 19, 0) THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
    after_meal := payload->'cursor'->>'mealId';
    after_dish := payload->'cursor'->>'dishId';
    after_position := (payload->'cursor'->>'position')::numeric::integer;
  END IF;

  search_pattern := '%' || replace(replace(replace(search_term, chr(92), chr(92) || chr(92)),
    '%', chr(92) || '%'), '_', chr(92) || '_') || '%';
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
    SELECT row_index, jsonb_build_object('mealDate', to_char(meal_date, 'YYYY-MM-DD'),
      'mealId', meal_id, 'position', position, 'dishId', dish_id) AS cursor_values, meal_type, name
    FROM numbered
  )
  SELECT jsonb_build_object(
    'items', COALESCE(jsonb_agg(cursor_values || jsonb_build_object('mealType', meal_type, 'dishName', name)
      ORDER BY row_index) FILTER (WHERE row_index <= page_limit), '[]'::jsonb),
    'nextCursor', CASE WHEN count(*) > page_limit
      THEN jsonb_agg(cursor_values) FILTER (WHERE row_index = page_limit)->0 ELSE NULL END
  ) INTO result FROM encoded;
  RETURN jsonb_build_object('ok', true, 'data', result);
END;
$meal_dish_search$ LANGUAGE plpgsql STABLE;

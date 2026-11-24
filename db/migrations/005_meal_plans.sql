ALTER TABLE meals DROP CONSTRAINT meals_status_check,
  ADD CONSTRAINT meals_status_check CHECK (status IN ('RECORDED', 'PLANNED'));

ALTER TABLE meal_command_requests DROP CONSTRAINT meal_command_requests_operation_check,
  ADD CONSTRAINT meal_command_requests_operation_check CHECK (operation IN ('create', 'update', 'delete', 'copy', 'record'));

CREATE OR REPLACE FUNCTION mille_meal_error(code text, current_version integer DEFAULT NULL) RETURNS jsonb AS $meal_error$
  SELECT jsonb_strip_nulls(jsonb_build_object('ok', false, 'code', code, 'currentVersion', current_version,
    'status', CASE code
      WHEN 'UNAUTHENTICATED' THEN 401 WHEN 'NOT_FOUND' THEN 404 WHEN 'INVALID_INPUT' THEN 400 ELSE 409 END,
    'error', CASE code
      WHEN 'UNAUTHENTICATED' THEN '利用可能なアカウントでログインしてください。'
      WHEN 'NOT_FOUND' THEN '献立またはワークスペースが見つかりません。'
      WHEN 'INVALID_INPUT' THEN '入力内容を確認してください。'
      WHEN 'SLOT_OCCUPIED' THEN '指定した日付と食事区分にはすでに献立があります。'
      WHEN 'VERSION_CONFLICT' THEN 'ほかの家族がこの献立を更新しました。最新版を確認してください。'
      WHEN 'NOT_PLANNED' THEN '予定の献立だけを記録済みにできます。'
      WHEN 'NOT_RECORDED' THEN '記録済みの献立だけをコピーできます。' END));
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
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error('UNAUTHENTICATED'); END IF;
  IF operation IS NULL OR operation NOT IN ('create', 'update', 'delete', 'adopt', 'record')
    OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'workspaceId') IS DISTINCT FROM 'string' THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>'workspaceId' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;

  IF operation = 'adopt' THEN
    target_date := mille_meal_date(payload->>'mealDate');
    target_type := payload->>'mealType';
    IF target_date IS NULL OR target_type IS NULL OR target_type NOT IN ('BREAKFAST', 'LUNCH', 'DINNER')
      OR (payload ? 'replaceMealId') <> (payload ? 'replaceVersion')
      OR (payload ? 'replaceMealId' AND (
        jsonb_typeof(payload->'replaceMealId') IS DISTINCT FROM 'string' OR btrim(payload->>'replaceMealId') = ''
        OR NOT mille_meal_number_valid(payload->'replaceVersion', 1, 2147483647, 0)
      )) THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;

    SELECT m.* INTO saved_meal FROM meals m
      WHERE m.workspace_id = target_workspace AND m.meal_date = target_date AND m.meal_type = target_type FOR UPDATE;
    IF saved_meal.status = 'RECORDED' THEN RETURN mille_meal_error('SLOT_OCCUPIED'); END IF;
    IF payload ? 'replaceMealId' THEN
      IF saved_meal.id IS DISTINCT FROM (payload->>'replaceMealId')
        OR saved_meal.version IS DISTINCT FROM (payload->>'replaceVersion')::numeric THEN
        RETURN mille_meal_error('VERSION_CONFLICT', saved_meal.version);
      END IF;
    ELSIF saved_meal.id IS NOT NULL THEN
      RETURN mille_meal_error('SLOT_OCCUPIED');
    END IF;
  ELSIF operation <> 'create' THEN
    IF jsonb_typeof(payload->'mealId') IS DISTINCT FROM 'string'
      OR NOT mille_meal_number_valid(payload->'expectedVersion', 1, 2147483647, 0) THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
    SELECT m.* INTO saved_meal FROM meals m WHERE m.id = payload->>'mealId' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error('NOT_FOUND'); END IF;
    IF saved_meal.version <> (payload->>'expectedVersion')::numeric THEN
      RETURN mille_meal_error('VERSION_CONFLICT', saved_meal.version);
    END IF;
    IF operation = 'record' AND saved_meal.status <> 'PLANNED' THEN
      RETURN mille_meal_error('NOT_PLANNED');
    END IF;
  END IF;

  IF operation <> 'delete' THEN
    IF operation <> 'adopt' THEN
      target_date := mille_meal_date(payload->>'mealDate');
      target_type := payload->>'mealType';
    END IF;
    IF target_date IS NULL OR target_type IS NULL OR target_type NOT IN ('BREAKFAST', 'LUNCH', 'DINNER')
      OR (operation = 'record' AND (target_date <> saved_meal.meal_date OR target_type <> saved_meal.meal_type))
      OR (NOT COALESCE(payload->'servings' = 'null'::jsonb, false) AND NOT mille_meal_number_valid(payload->'servings', 0.01, 99, 2))
      OR NOT mille_meal_dishes_valid(payload->'dishes', CASE WHEN operation = 'adopt' THEN NULL ELSE saved_meal.id END) THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
  END IF;

  -- Convert known conflicts only inside a subtransaction so any partial changes are rolled back.
  BEGIN
    IF operation = 'delete' THEN
      DELETE FROM meals WHERE id = saved_meal.id;
      RETURN jsonb_build_object('ok', true, 'data', NULL);
    END IF;

    SET CONSTRAINTS meal_dishes_position_uq, dish_ingredients_position_uq DEFERRED;
    IF saved_meal.id IS NULL THEN
      INSERT INTO meals (workspace_id, meal_date, meal_type, status, servings, created_by, updated_by)
        VALUES (target_workspace, target_date, target_type, CASE WHEN operation = 'adopt' THEN 'PLANNED' ELSE 'RECORDED' END,
          (payload->>'servings')::numeric, actor.id, actor.id)
        RETURNING * INTO saved_meal;
    ELSE
      UPDATE meals m SET meal_date = target_date, meal_type = target_type, servings = (payload->>'servings')::numeric,
        status = CASE WHEN operation = 'record' THEN 'RECORDED' ELSE m.status END,
        version = m.version + 1, updated_by = actor.id, updated_at = clock_timestamp()
        WHERE m.id = saved_meal.id RETURNING * INTO saved_meal;
      DELETE FROM meal_dishes d WHERE d.meal_id = saved_meal.id AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(payload->'dishes') AS input(value) WHERE value->>'id' = d.id);
    END IF;

    FOR dish IN SELECT value, ordinality - 1 AS position FROM jsonb_array_elements(payload->'dishes') WITH ORDINALITY LOOP
      saved_dish_id := dish.value->>'id';
      IF saved_dish_id IS NULL THEN
        INSERT INTO meal_dishes (meal_id, position, name, servings, recipe_text, recipe_url)
          VALUES (saved_meal.id, dish.position, dish.value->>'name', (dish.value->>'servings')::numeric,
            dish.value->>'recipeText', dish.value->>'recipeUrl') RETURNING id INTO saved_dish_id;
      ELSE
        UPDATE meal_dishes d SET position = dish.position, name = dish.value->>'name', servings = (dish.value->>'servings')::numeric,
          recipe_text = dish.value->>'recipeText', recipe_url = dish.value->>'recipeUrl'
          WHERE d.id = saved_dish_id AND d.meal_id = saved_meal.id;
        DELETE FROM dish_ingredients i WHERE i.dish_id = saved_dish_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(dish.value->'ingredients') AS input(value) WHERE value->>'id' = i.id);
        UPDATE dish_ingredients i SET position = input.ordinality - 1, name = input.value->>'name',
          amount_text = input.value->>'amountText', unit = input.value->>'unit'
          FROM jsonb_array_elements(dish.value->'ingredients') WITH ORDINALITY AS input(value, ordinality)
          WHERE i.dish_id = saved_dish_id AND i.id = input.value->>'id';
      END IF;
      INSERT INTO dish_ingredients (dish_id, position, name, amount_text, unit)
        SELECT saved_dish_id, ordinality - 1, value->>'name', value->>'amountText', value->>'unit'
          FROM jsonb_array_elements(dish.value->'ingredients') WITH ORDINALITY WHERE NOT (value ? 'id');
    END LOOP;

    SET CONSTRAINTS meal_dishes_position_uq, dish_ingredients_position_uq IMMEDIATE;
    RETURN jsonb_build_object('ok', true, 'data', mille_meal_json(saved_meal, true));
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
    IF conflict_constraint = 'meals_workspace_slot_uq' THEN RETURN mille_meal_error('SLOT_OCCUPIED'); END IF;
    RAISE;
  END;
END;
$meal_command$ LANGUAGE plpgsql;

-- The suggestion command validates the candidate and records the replay result in the same transaction.
CREATE FUNCTION mille_meal_adopt_plan(actor_id text, actor_email text, payload jsonb)
RETURNS jsonb AS $meal_adopt$
  SELECT mille_meal_command(actor_id, actor_email, 'adopt', payload);
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
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error('UNAUTHENTICATED'); END IF;
  IF operation IS NULL OR operation NOT IN ('create', 'update', 'delete', 'copy', 'record')
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
    IF source_meal.status <> 'RECORDED' THEN RETURN mille_meal_error('NOT_RECORDED'); END IF;

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
    WHERE m.workspace_id = target_workspace AND m.status = 'RECORDED' AND d.name ILIKE search_pattern ESCAPE chr(92)
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

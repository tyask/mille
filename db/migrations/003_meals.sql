CREATE TABLE meals (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meal_date date NOT NULL CHECK (meal_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  meal_type text NOT NULL CHECK (meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER')),
  status text NOT NULL DEFAULT 'RECORDED' CHECK (status = 'RECORDED'),
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
  name text NOT NULL CHECK (name = btrim(name) AND name COLLATE "C" ~ '[^[:space:]]' AND char_length(name) <= 120),
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
  name text NOT NULL CHECK (name = btrim(name) AND name COLLATE "C" ~ '[^[:space:]]' AND char_length(name) <= 120),
  amount_text text CHECK (char_length(amount_text) <= 40),
  unit text CHECK (char_length(unit) <= 20),
  CONSTRAINT dish_ingredients_position_uq UNIQUE (dish_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION mille_meal_date(input text) RETURNS date AS $meal_date$
BEGIN
  IF input !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  RETURN input::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$meal_date$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION mille_meal_number_valid(input jsonb, minimum numeric, maximum numeric, decimal_places integer)
RETURNS boolean AS $meal_number$
  SELECT CASE WHEN jsonb_typeof(input) = 'number' THEN
    (input #>> '{}')::numeric BETWEEN minimum AND maximum
      AND min_scale((input #>> '{}')::numeric) <= decimal_places
    ELSE false END;
$meal_number$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_name_valid(input jsonb) RETURNS boolean AS $meal_name$
  SELECT jsonb_typeof(input) IS NOT DISTINCT FROM 'string'
    AND (input #>> '{}') = btrim(input #>> '{}')
    AND (input #>> '{}') COLLATE "C" ~ '[^[:space:]]' AND char_length(input #>> '{}') <= 120;
$meal_name$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_optional_text_valid(input jsonb, maximum integer) RETURNS boolean AS $meal_text$
  SELECT CASE jsonb_typeof(input)
    WHEN 'null' THEN true
    WHEN 'string' THEN char_length(input #>> '{}') BETWEEN 1 AND maximum
    ELSE false END;
$meal_text$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_error(code text, current_version integer DEFAULT NULL) RETURNS jsonb AS $meal_error$
  SELECT jsonb_strip_nulls(jsonb_build_object('ok', false, 'code', code, 'currentVersion', current_version,
    'status', CASE code
      WHEN 'UNAUTHENTICATED' THEN 401 WHEN 'NOT_FOUND' THEN 404 WHEN 'INVALID_INPUT' THEN 400 ELSE 409 END,
    'error', CASE code
      WHEN 'UNAUTHENTICATED' THEN '利用可能なアカウントでログインしてください。'
      WHEN 'NOT_FOUND' THEN '献立またはワークスペースが見つかりません。'
      WHEN 'INVALID_INPUT' THEN '入力内容を確認してください。'
      WHEN 'SLOT_OCCUPIED' THEN '指定した日付と食事区分にはすでに献立があります。'
      WHEN 'VERSION_CONFLICT' THEN 'ほかの家族がこの献立を更新しました。最新版を確認してください。' END));
$meal_error$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_meal_actor_allowed(actor app_users) RETURNS boolean AS $meal_actor$
  SELECT (actor).is_enabled AND NOT EXISTS (
    SELECT 1 FROM mille_environment WHERE environment = 'production'
      AND ((actor).is_test OR (actor).id LIKE 'mille-test-user-%' OR (actor).email LIKE '%@mille.invalid')
  );
$meal_actor$ LANGUAGE sql STABLE;

CREATE FUNCTION mille_meal_json(meal meals, include_details boolean) RETURNS jsonb AS $meal_json$
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
      ) ELSE '{}'::jsonb END ORDER BY d.position
    ) FROM meal_dishes d WHERE d.meal_id = (meal).id), '[]'::jsonb)
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
    RETURN mille_meal_error('UNAUTHENTICATED');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'workspaceId') IS DISTINCT FROM 'string' THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  target_workspace := payload->>'workspaceId';
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor_id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;

  IF operation = 'list' THEN
    range_start := mille_meal_date(payload->>'from');
    -- The expanded ISO date is only accepted as the exclusive end of 9999-12-31.
    range_end := CASE WHEN payload->>'to' = '+010000-01-01' THEN DATE '10000-01-01'
      ELSE mille_meal_date(payload->>'to') END;
    IF range_start IS NULL OR range_end IS NULL OR range_end - range_start NOT BETWEEN 1 AND 62 THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
    SELECT COALESCE(jsonb_agg(mille_meal_json(m, false) ORDER BY m.meal_date,
      CASE m.meal_type WHEN 'BREAKFAST' THEN 1 WHEN 'LUNCH' THEN 2 ELSE 3 END), '[]'::jsonb)
      INTO result FROM meals m WHERE m.workspace_id = target_workspace AND m.meal_date >= range_start AND m.meal_date < range_end;
  ELSIF operation = 'get' THEN
    IF jsonb_typeof(payload->'mealId') IS DISTINCT FROM 'string' THEN RETURN mille_meal_error('INVALID_INPUT'); END IF;
    SELECT mille_meal_json(m, true) INTO result FROM meals m
      WHERE m.workspace_id = target_workspace AND m.id = payload->>'mealId';
    IF NOT FOUND THEN RETURN mille_meal_error('NOT_FOUND'); END IF;
  ELSE
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  RETURN jsonb_build_object('ok', true, 'data', result);
END;
$meal_read$ LANGUAGE plpgsql STABLE;

-- A retained ID must belong to the existing parent. A new parent can only receive new children.
CREATE FUNCTION mille_meal_dishes_valid(input jsonb, existing_meal_id text) RETURNS boolean AS $meal_dishes_valid$
DECLARE
  dish jsonb;
  existing_dish_id text;
  recipe_url text;
  seen_dish_ids text[] := '{}';
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(input) NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
  FOR dish IN SELECT value FROM jsonb_array_elements(input) LOOP
    IF jsonb_typeof(dish) IS DISTINCT FROM 'object' OR NOT mille_meal_name_valid(dish->'name')
      OR (NOT COALESCE(dish->'servings' = 'null'::jsonb, false) AND NOT mille_meal_number_valid(dish->'servings', 0.01, 99, 2))
      OR NOT mille_meal_optional_text_valid(dish->'recipeText', 10000)
      OR NOT mille_meal_optional_text_valid(dish->'recipeUrl', 2048)
      OR jsonb_typeof(dish->'ingredients') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(dish->'ingredients') > 100 THEN RETURN false; END IF;
    recipe_url := dish->>'recipeUrl';
    IF recipe_url IS NOT NULL AND (dish->>'recipeText' IS NOT NULL
      OR recipe_url !~* '^https?://[^/?#@]+([/?#].*)?$'
      OR recipe_url COLLATE "C" ~ '[[:space:]]' OR strpos(recipe_url, chr(92)) > 0) THEN RETURN false; END IF;

    existing_dish_id := dish->>'id';
    IF dish ? 'id' THEN
      IF jsonb_typeof(dish->'id') IS DISTINCT FROM 'string' OR existing_dish_id = ANY(seen_dish_ids)
        OR NOT EXISTS (SELECT 1 FROM meal_dishes d WHERE d.id = existing_dish_id AND d.meal_id = existing_meal_id) THEN
        RETURN false;
      END IF;
      seen_dish_ids := array_append(seen_dish_ids, existing_dish_id);
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(dish->'ingredients') AS inputs(ingredient)
      WHERE jsonb_typeof(ingredient) IS DISTINCT FROM 'object' OR NOT mille_meal_name_valid(ingredient->'name')
        OR NOT mille_meal_optional_text_valid(ingredient->'amountText', 40)
        OR NOT mille_meal_optional_text_valid(ingredient->'unit', 20)
        OR (ingredient ? 'id' AND (jsonb_typeof(ingredient->'id') IS DISTINCT FROM 'string'
          OR NOT EXISTS (SELECT 1 FROM dish_ingredients i WHERE i.id = ingredient->>'id' AND i.dish_id = existing_dish_id))))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(dish->'ingredients') AS inputs(ingredient)
        WHERE ingredient ? 'id' GROUP BY ingredient->>'id' HAVING count(*) > 1) THEN RETURN false; END IF;
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
  IF NOT FOUND OR NOT mille_meal_actor_allowed(actor) THEN RETURN mille_meal_error('UNAUTHENTICATED'); END IF;
  IF operation IS NULL OR operation NOT IN ('create', 'update', 'delete')
    OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'workspaceId') IS DISTINCT FROM 'string' THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
  SELECT w.id INTO target_workspace FROM workspaces w WHERE w.id = payload->>'workspaceId' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_meal_error('NOT_FOUND');
  END IF;

  IF operation <> 'create' THEN
    IF jsonb_typeof(payload->'mealId') IS DISTINCT FROM 'string'
      OR NOT mille_meal_number_valid(payload->'expectedVersion', 1, 2147483647, 0) THEN
      RETURN mille_meal_error('INVALID_INPUT');
    END IF;
    SELECT m.* INTO saved_meal FROM meals m WHERE m.id = payload->>'mealId' AND m.workspace_id = target_workspace FOR UPDATE;
    IF NOT FOUND THEN RETURN mille_meal_error('NOT_FOUND'); END IF;
    IF saved_meal.version <> (payload->>'expectedVersion')::numeric THEN
      RETURN mille_meal_error('VERSION_CONFLICT', saved_meal.version);
    END IF;
  END IF;

  IF operation <> 'delete' THEN
    target_date := mille_meal_date(payload->>'mealDate');
    target_type := payload->>'mealType';
    IF target_date IS NULL OR target_type IS NULL OR target_type NOT IN ('BREAKFAST', 'LUNCH', 'DINNER')
      OR (NOT COALESCE(payload->'servings' = 'null'::jsonb, false) AND NOT mille_meal_number_valid(payload->'servings', 0.01, 99, 2))
      OR NOT mille_meal_dishes_valid(payload->'dishes', saved_meal.id) THEN
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
    IF operation = 'create' THEN
      INSERT INTO meals (workspace_id, meal_date, meal_type, servings, created_by, updated_by)
        VALUES (target_workspace, target_date, target_type, (payload->>'servings')::numeric, actor.id, actor.id)
        RETURNING * INTO saved_meal;
    ELSE
      UPDATE meals m SET meal_date = target_date, meal_type = target_type, servings = (payload->>'servings')::numeric,
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

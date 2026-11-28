-- Add recorded ingredient names to the existing dish search contract.
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
  search_by := COALESCE(payload->>'by', 'name');
  IF payload ? 'by' AND (jsonb_typeof(payload->'by') IS DISTINCT FROM 'string'
    OR search_by NOT IN ('name', 'ingredient')) THEN
    RETURN mille_meal_error('INVALID_INPUT');
  END IF;
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
    WHERE m.workspace_id = target_workspace AND m.status = 'RECORDED'
      AND CASE WHEN search_by = 'ingredient' THEN EXISTS (
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

CREATE TABLE meal_suggestions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES app_users(id),
  conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'object'),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidates) = 'array'),
  messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array'),
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
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('create', 'revise', 'adopt')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  message text,
  failure text CHECK (failure IN ('TIMEOUT', 'UNAVAILABLE', 'INVALID_OUTPUT')),
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
    'id', (suggestion).id, 'version', (suggestion).version, 'conditions', (suggestion).conditions,
    'candidates', (suggestion).candidates, 'messages', (suggestion).messages,
    'request', jsonb_build_object(
      'id', (attempt).id, 'status', CASE WHEN (attempt).status = 'RUNNING'
        AND (attempt).lease_until <= observed_at THEN 'EXPIRED' ELSE (attempt).status END,
      'failure', (attempt).failure, 'message', (attempt).message
    )
  );
$suggestion_view$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_suggestion_error(code text, current_version integer DEFAULT NULL)
RETURNS jsonb AS $suggestion_error$
  SELECT CASE code
    WHEN 'GENERATION_IN_PROGRESS' THEN jsonb_build_object(
      'ok', false, 'status', 409, 'code', code, 'error', '献立案を作成中です。完了後にもう一度お試しください。')
    WHEN 'VERSION_CONFLICT' THEN jsonb_strip_nulls(jsonb_build_object(
      'ok', false, 'status', 409, 'code', code, 'currentVersion', current_version,
      'error', '献立案が更新されました。最新版を確認してください。'))
    WHEN 'IDEMPOTENCY_KEY_REUSED' THEN jsonb_build_object(
      'ok', false, 'status', 409, 'code', code, 'error', '同じ送信キーに異なる入力が指定されました。')
    ELSE mille_meal_error(code)
  END;
$suggestion_error$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION mille_suggestion_recent_dishes(target_workspace text, target_date date)
RETURNS jsonb AS $suggestion_history$
  WITH recent_meals AS (
    SELECT m.id, m.meal_date FROM meals m
    WHERE m.workspace_id = target_workspace AND m.status = 'RECORDED'
      AND m.meal_date >= target_date - 14 AND m.meal_date < target_date
    ORDER BY m.meal_date DESC, m.id DESC
    LIMIT 42
  ), recent_dishes AS (
    SELECT d.name, m.meal_date, m.id AS meal_id, d.position
    FROM recent_meals m JOIN meal_dishes d ON d.meal_id = m.id
    ORDER BY m.meal_date DESC, m.id DESC, d.position
    LIMIT 120
  )
  SELECT COALESCE(jsonb_agg(name ORDER BY meal_date DESC, meal_id DESC, position), '[]'::jsonb)
  FROM recent_dishes;
$suggestion_history$ LANGUAGE sql STABLE;

CREATE FUNCTION mille_suggestion_command(actor_id text, actor_email text, operation text, payload jsonb)
RETURNS jsonb AS $suggestion_command$
DECLARE
  actor app_users%ROWTYPE;
  target_workspace text := payload->>'workspaceId';
  target_id text := payload->>'suggestionId';
  supplied_key text := payload->>'requestKey';
  supplied_hash text := payload->>'requestHash';
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
    RETURN mille_suggestion_error('UNAUTHENTICATED');
  END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = target_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace AND m.user_id = actor.id) THEN
    RETURN mille_suggestion_error('NOT_FOUND');
  END IF;
  observed_at := clock_timestamp();

  IF operation IN ('create', 'revise', 'adopt') THEN
    IF supplied_key IS NULL OR char_length(supplied_key) NOT BETWEEN 1 AND 128
      OR supplied_hash IS NULL OR supplied_hash !~ '^[a-f0-9]{64}$' THEN
      RETURN mille_suggestion_error('INVALID_INPUT');
    END IF;
    SELECT r.* INTO attempt FROM meal_suggestion_requests r
      WHERE r.workspace_id = target_workspace AND r.actor_id = actor.id AND r.request_key = supplied_key;
    IF FOUND THEN
      IF attempt.request_hash <> supplied_hash THEN
        RETURN mille_suggestion_error('IDEMPOTENCY_KEY_REUSED');
      END IF;
      IF attempt.response_json IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'data', attempt.response_json);
      END IF;
      SELECT s.* INTO STRICT suggestion FROM meal_suggestions s WHERE s.id = attempt.suggestion_id;
      RETURN jsonb_build_object('ok', true, 'data', mille_suggestion_view(suggestion, attempt, observed_at));
    END IF;
  END IF;

  IF operation = 'create' THEN
    INSERT INTO meal_suggestions(workspace_id, created_by, conditions)
      VALUES (target_workspace, actor.id, payload->'conditions') RETURNING * INTO suggestion;
  ELSE
    SELECT s.* INTO suggestion FROM meal_suggestions s
      WHERE s.id = target_id AND s.workspace_id = target_workspace;
    IF NOT FOUND THEN RETURN mille_suggestion_error('NOT_FOUND'); END IF;
    SELECT r.* INTO STRICT attempt FROM meal_suggestion_requests r WHERE r.id = suggestion.latest_request_id;
  END IF;

  IF operation = 'get' THEN
    RETURN jsonb_build_object('ok', true, 'data', mille_suggestion_view(suggestion, attempt, observed_at));
  END IF;

  IF operation = 'finish' THEN
    IF attempt.id IS DISTINCT FROM payload->>'requestId' THEN
      SELECT r.* INTO attempt FROM meal_suggestion_requests r WHERE r.id = payload->>'requestId'
        AND r.actor_id = actor.id AND r.suggestion_id = suggestion.id;
      IF NOT FOUND THEN RETURN mille_suggestion_error('NOT_FOUND'); END IF;
    END IF;
    IF attempt.actor_id <> actor.id THEN RETURN mille_suggestion_error('NOT_FOUND'); END IF;
    IF attempt.response_json IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'data', attempt.response_json);
    END IF;
    IF attempt.id <> suggestion.latest_request_id OR attempt.expected_version <> suggestion.version
      OR attempt.status <> 'RUNNING' THEN
      RETURN mille_suggestion_error('VERSION_CONFLICT', suggestion.version);
    END IF;

    IF attempt.lease_until <= observed_at THEN
      attempt.status := 'EXPIRED';
    ELSIF payload->>'failure' IS NOT NULL THEN
      attempt.status := 'FAILED';
      attempt.failure := payload->>'failure';
    ELSE
      attempt.status := 'SUCCEEDED';
      UPDATE meal_suggestions s SET
        candidates = payload->'candidates', version = s.version + 1,
        messages = CASE WHEN attempt.message IS NULL THEN s.messages ELSE s.messages || to_jsonb(attempt.message) END
        WHERE s.id = suggestion.id RETURNING * INTO suggestion;
    END IF;
    reply := mille_suggestion_view(suggestion, attempt, observed_at);
    UPDATE meal_suggestion_requests r SET status = attempt.status, failure = attempt.failure, response_json = reply
      WHERE r.id = attempt.id;
    RETURN jsonb_build_object('ok', true, 'data', reply);
  END IF;

  IF operation IN ('revise', 'adopt') THEN
    supplied_version := (payload->>'expectedVersion')::integer;
    IF attempt.status = 'RUNNING' AND attempt.lease_until > observed_at THEN
      RETURN mille_suggestion_error('GENERATION_IN_PROGRESS');
    END IF;
    IF supplied_version IS DISTINCT FROM suggestion.version THEN
      RETURN mille_suggestion_error('VERSION_CONFLICT', suggestion.version);
    END IF;
  END IF;

  IF operation = 'adopt' THEN
    SELECT item.value INTO candidate FROM jsonb_array_elements(suggestion.candidates) AS item(value)
      WHERE item.value->>'id' = payload->>'candidateId';
    IF NOT FOUND THEN RETURN mille_suggestion_error('NOT_FOUND'); END IF;
    meal_payload := jsonb_build_object(
      'workspaceId', target_workspace, 'mealDate', suggestion.conditions->'mealDate',
      'mealType', suggestion.conditions->'mealType', 'servings', suggestion.conditions->'servings',
      'dishes', candidate->'dishes'
    );
    IF payload ? 'replaceVersion' THEN
      IF payload->'confirmReplacement' IS DISTINCT FROM 'true'::jsonb THEN
        RETURN mille_suggestion_error('INVALID_INPUT');
      END IF;
      meal_payload := meal_payload || jsonb_build_object(
        'replaceMealId', payload->'replaceMealId', 'replaceVersion', payload->'replaceVersion');
    END IF;
    reply := mille_meal_adopt_plan(actor.id, actor_email, meal_payload);
    IF (reply->>'ok')::boolean THEN
      INSERT INTO meal_suggestion_requests(
        suggestion_id, workspace_id, actor_id, request_key, request_hash, operation, status, expected_version, response_json
      ) VALUES (suggestion.id, target_workspace, actor.id, supplied_key, supplied_hash, operation, 'SUCCEEDED',
        supplied_version, reply->'data');
    END IF;
    RETURN reply;
  END IF;

  IF operation IN ('create', 'revise') THEN
    IF attempt.status = 'RUNNING' THEN
      -- A past lease can no longer finish. Store its view before changing which request is current.
      attempt.status := 'EXPIRED';
      UPDATE meal_suggestion_requests r SET status = attempt.status,
        response_json = mille_suggestion_view(suggestion, attempt, observed_at) WHERE r.id = attempt.id;
    END IF;
    INSERT INTO meal_suggestion_requests(
      suggestion_id, workspace_id, actor_id, request_key, request_hash, operation, status, expected_version,
      message, provider_model, prompt_version, lease_until
    ) VALUES (suggestion.id, target_workspace, actor.id, supplied_key, supplied_hash, operation, 'RUNNING',
      suggestion.version, payload->>'message', payload->>'providerModel', payload->>'promptVersion',
      observed_at + interval '60 seconds') RETURNING * INTO attempt;
    UPDATE meal_suggestions s SET latest_request_id = attempt.id WHERE s.id = suggestion.id;
    RETURN jsonb_build_object('ok', true, 'data', mille_suggestion_view(suggestion, attempt, observed_at),
      'recentDishes', mille_suggestion_recent_dishes(target_workspace, mille_meal_date(suggestion.conditions->>'mealDate')));
  END IF;

  RETURN mille_suggestion_error('INVALID_INPUT');
END;
$suggestion_command$ LANGUAGE plpgsql;

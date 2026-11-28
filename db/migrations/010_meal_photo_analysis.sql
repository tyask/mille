CREATE TABLE meal_photo_analyses (
  photo_id uuid NOT NULL REFERENCES meal_photos(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (model IN ('sample', 'gpt-6-luna')),
  prompt_version text NOT NULL,
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  meal_version integer,
  lease uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  PRIMARY KEY (photo_id, model, prompt_version)
);

CREATE TABLE mille_meal_photo_preview (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  environment_id text NOT NULL CHECK (environment_id ~ '^mille-pr-[1-9][0-9]*$'),
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  deployment_id text NOT NULL CHECK (deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
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
    RETURN jsonb_build_object('status', 'unauthenticated');
  END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = target_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspace_members w WHERE w.workspace_id = target_workspace AND w.user_id = actor_id
  ) THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;
  SELECT p.* INTO photo FROM meal_photos p
    WHERE p.id = target_photo AND p.workspace_id = target_workspace AND p.bytes IS NOT NULL
      AND (p.dish_id IS NOT NULL OR (p.created_by = actor_id AND p.expires_at > clock_timestamp()))
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  SELECT a.* INTO job FROM meal_photo_analyses a
    WHERE a.photo_id = target_photo AND a.model = target_model AND a.prompt_version = target_prompt;

  IF operation = 'start' THEN
    IF encode(sha256(photo.bytes), 'hex') IS DISTINCT FROM payload->>'imageSha256' THEN
      RETURN jsonb_build_object('status', 'missing');
    END IF;
    IF job.result IS NOT NULL THEN RETURN jsonb_build_object('status', 'ready', 'result', job.result); END IF;
    IF job.lease_expires_at > clock_timestamp() THEN RETURN jsonb_build_object('status', 'pending'); END IF;
    IF target_model = 'gpt-6-luna' THEN
      UPDATE mille_meal_photo_preview SET request_count = request_count + 1
        WHERE id AND enabled AND environment_id = payload->>'environmentId'
          AND source_sha = payload->>'sourceSha' AND deployment_id = payload->>'deploymentId'
          AND request_count < 10;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'limited'); END IF;
    END IF;
    INSERT INTO meal_photo_analyses (photo_id, model, prompt_version, image_sha256, meal_version, lease, lease_expires_at)
      VALUES (target_photo, target_model, target_prompt, payload->>'imageSha256',
        (SELECT m.version FROM meal_dishes d JOIN meals m ON m.id = d.meal_id WHERE d.id = photo.dish_id),
        target_lease, clock_timestamp() + interval '45 seconds')
      ON CONFLICT (photo_id, model, prompt_version) DO UPDATE SET image_sha256 = EXCLUDED.image_sha256,
        meal_version = EXCLUDED.meal_version, lease = EXCLUDED.lease, lease_expires_at = EXCLUDED.lease_expires_at;
    RETURN jsonb_build_object('status', 'started');
  END IF;

  IF job.lease IS DISTINCT FROM target_lease OR job.result IS NOT NULL
    OR job.lease_expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('status', 'pending'); END IF;
  IF operation = 'finish' THEN
    UPDATE meal_photo_analyses a SET result = payload
      WHERE a.photo_id = target_photo AND a.model = target_model AND a.prompt_version = target_prompt;
    RETURN jsonb_build_object('status', 'ready', 'result', payload);
  END IF;
  IF operation = 'fail' THEN
    DELETE FROM meal_photo_analyses a
      WHERE a.photo_id = target_photo AND a.model = target_model AND a.prompt_version = target_prompt;
    RETURN jsonb_build_object('status', 'released');
  END IF;
  RAISE EXCEPTION 'Unknown meal photo analysis operation';
END;
$analysis$ LANGUAGE plpgsql;

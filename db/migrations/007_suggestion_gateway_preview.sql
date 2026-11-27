CREATE TABLE mille_suggestion_gateway_preview (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  environment_id text NOT NULL CHECK (environment_id COLLATE "C" ~ '^mille-pr-[1-9][0-9]*$'),
  source_sha text NOT NULL CHECK (source_sha COLLATE "C" ~ '^[0-9a-f]{40}$'),
  deployment_id text NOT NULL CHECK (deployment_id COLLATE "C" ~ '^dpl_[A-Za-z0-9]+$'),
  enabled boolean NOT NULL DEFAULT false,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 10)
);

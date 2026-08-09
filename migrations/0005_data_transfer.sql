BEGIN;

ALTER TABLE ai_analysis_revisions
    ALTER COLUMN task_id DROP NOT NULL,
    ALTER COLUMN model_config_version DROP NOT NULL;

CREATE TABLE data_exports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    manifest jsonb,
    archive bytea,
    failure_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE TABLE restore_inspections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL CHECK (status IN ('VALID', 'INVALID')),
    format_version integer,
    record_count integer,
    can_restore boolean NOT NULL,
    blocking_reason text,
    archive bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_restores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id uuid NOT NULL REFERENCES restore_inspections (id),
    status text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
    record_count integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

BEGIN;

CREATE TYPE ai_task_handling AS ENUM ('AUTOMATIC', 'REVIEW');
CREATE TYPE ai_task_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE ai_analysis_status AS ENUM (
    'GENERATED',
    'ACTIVE',
    'SUPERSEDED',
    'DISCARDED',
    'STALE'
);
CREATE TYPE knowledge_publication_status AS ENUM (
    'AI_CREATED',
    'PENDING_REVIEW',
    'AUTO_PUBLISHED',
    'CONFIRMED',
    'REJECTED'
);
CREATE TYPE knowledge_usage_status AS ENUM ('INCLUDED', 'EXCLUDED');

CREATE TABLE ai_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    fragment_revision_id uuid NOT NULL,
    model_config_version integer NOT NULL
        REFERENCES model_configurations (version) ON DELETE RESTRICT,
    handling ai_task_handling NOT NULL,
    status ai_task_status NOT NULL DEFAULT 'QUEUED',
    generation_attempts smallint NOT NULL DEFAULT 0,
    failure_code text,
    failure_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT ai_tasks_fragment_revision_fk
        FOREIGN KEY (record_id, fragment_revision_id)
        REFERENCES fragment_revisions (record_id, id) ON DELETE CASCADE,
    CONSTRAINT ai_tasks_attempts_check
        CHECK (generation_attempts BETWEEN 0 AND 2),
    CONSTRAINT ai_tasks_finish_state_check CHECK (
        (status IN ('QUEUED', 'RUNNING') AND finished_at IS NULL)
        OR (status IN ('SUCCEEDED', 'FAILED') AND finished_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX ai_tasks_one_unfinished_per_revision_idx
    ON ai_tasks (fragment_revision_id)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX ai_tasks_observable_status_idx
    ON ai_tasks (status, created_at DESC);

CREATE TABLE ai_analysis_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    fragment_revision_id uuid NOT NULL,
    task_id uuid NOT NULL UNIQUE REFERENCES ai_tasks (id) ON DELETE CASCADE,
    model_config_version integer NOT NULL
        REFERENCES model_configurations (version) ON DELETE RESTRICT,
    text_model text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    status ai_analysis_status NOT NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ai_analysis_fragment_revision_fk
        FOREIGN KEY (record_id, fragment_revision_id)
        REFERENCES fragment_revisions (record_id, id) ON DELETE CASCADE,
    CONSTRAINT ai_analysis_title_check CHECK (title <> ''),
    CONSTRAINT ai_analysis_summary_check CHECK (summary <> ''),
    CONSTRAINT ai_analysis_record_id_unique UNIQUE (record_id, id)
);

ALTER TABLE records ADD COLUMN current_analysis_revision_id uuid;
ALTER TABLE records
    ADD CONSTRAINT records_current_analysis_revision_fk
    FOREIGN KEY (id, current_analysis_revision_id)
    REFERENCES ai_analysis_revisions (record_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE knowledge_points (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    fragment_revision_id uuid NOT NULL,
    analysis_revision_id uuid NOT NULL
        REFERENCES ai_analysis_revisions (id) ON DELETE CASCADE,
    position smallint NOT NULL,
    ai_title text NOT NULL,
    ai_body text NOT NULL,
    publication_status knowledge_publication_status NOT NULL,
    usage_status knowledge_usage_status NOT NULL DEFAULT 'INCLUDED',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_points_fragment_revision_fk
        FOREIGN KEY (record_id, fragment_revision_id)
        REFERENCES fragment_revisions (record_id, id) ON DELETE CASCADE,
    CONSTRAINT knowledge_points_position_check CHECK (position BETWEEN 1 AND 5),
    CONSTRAINT knowledge_points_title_check CHECK (ai_title <> ''),
    CONSTRAINT knowledge_points_body_check CHECK (ai_body <> ''),
    CONSTRAINT knowledge_points_analysis_position_unique
        UNIQUE (analysis_revision_id, position)
);

CREATE TABLE evidence_spans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    fragment_revision_id uuid NOT NULL
        REFERENCES fragment_revisions (id) ON DELETE CASCADE,
    position smallint NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    quote text NOT NULL,
    CONSTRAINT evidence_spans_position_check CHECK (position >= 1),
    CONSTRAINT evidence_spans_offsets_check
        CHECK (start_offset >= 0 AND end_offset > start_offset),
    CONSTRAINT evidence_spans_quote_check CHECK (quote <> ''),
    CONSTRAINT evidence_spans_point_position_unique
        UNIQUE (knowledge_point_id, position)
);

ALTER TABLE tag_assignments
    DROP CONSTRAINT tag_assignments_record_target_check,
    DROP CONSTRAINT tag_assignments_record_status_check,
    DROP CONSTRAINT tag_assignments_record_tag_unique,
    ALTER COLUMN record_id DROP NOT NULL,
    ADD COLUMN knowledge_point_id uuid
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    ADD CONSTRAINT tag_assignments_exactly_one_target_check CHECK (
        (record_id IS NOT NULL)::integer
        + (knowledge_point_id IS NOT NULL)::integer = 1
    ),
    ADD CONSTRAINT tag_assignments_actor_target_check CHECK (
        (record_id IS NOT NULL AND assigned_by = 'USER' AND status = 'ACTIVE')
        OR (knowledge_point_id IS NOT NULL AND assigned_by = 'AI')
    );

CREATE UNIQUE INDEX tag_assignments_record_tag_unique_idx
    ON tag_assignments (record_id, tag_id)
    WHERE record_id IS NOT NULL;

CREATE UNIQUE INDEX tag_assignments_knowledge_point_tag_unique_idx
    ON tag_assignments (knowledge_point_id, tag_id)
    WHERE knowledge_point_id IS NOT NULL;

CREATE INDEX knowledge_points_active_record_idx
    ON knowledge_points (record_id, position)
    WHERE publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
      AND usage_status = 'INCLUDED';

CREATE INDEX evidence_spans_point_idx
    ON evidence_spans (knowledge_point_id, position);

COMMIT;

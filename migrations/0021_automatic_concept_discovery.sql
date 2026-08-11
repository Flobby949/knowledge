BEGIN;

ALTER TABLE concept_candidate_scans
    ADD COLUMN trigger_analysis_revision_id uuid
        REFERENCES ai_analysis_revisions (id) ON DELETE CASCADE;

ALTER TABLE concept_candidate_scans
    DROP CONSTRAINT concept_candidate_scans_input_count_check;

ALTER TABLE concept_candidate_scans
    ADD CONSTRAINT concept_candidate_scans_input_count_check CHECK (
        input_count BETWEEN 1 AND 12
    );

ALTER TABLE concept_candidate_scans
    ADD CONSTRAINT concept_candidate_scans_automatic_single_input_check CHECK (
        input_count >= 2 OR trigger_analysis_revision_id IS NOT NULL
    );

CREATE UNIQUE INDEX concept_candidate_scans_trigger_analysis_unique
    ON concept_candidate_scans (trigger_analysis_revision_id)
    WHERE trigger_analysis_revision_id IS NOT NULL;

CREATE TABLE concept_candidate_discovery_queue (
    analysis_revision_id uuid PRIMARY KEY
        REFERENCES ai_analysis_revisions (id) ON DELETE CASCADE,
    enqueued_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX concept_candidate_discovery_queue_pending_idx
    ON concept_candidate_discovery_queue (enqueued_at, analysis_revision_id)
    WHERE processed_at IS NULL;

COMMIT;

BEGIN;

ALTER TABLE concept_relations
    DROP CONSTRAINT concept_relations_confirmation_source_check,
    ADD CONSTRAINT concept_relations_confirmation_source_check CHECK (
        (confirmation_source IN ('AI_SUGGESTION', 'AI_AUTOMATIC')
            AND suggestion_id IS NOT NULL)
        OR (confirmation_source = 'USER' AND suggestion_id IS NULL)
    );

CREATE TABLE concept_relation_automatic_evaluations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_key text NOT NULL,
    input_fingerprint text NOT NULL,
    outcome text NOT NULL,
    relation_id uuid REFERENCES concept_relations (id) ON DELETE RESTRICT,
    model_configuration_version integer NOT NULL,
    text_model text NOT NULL,
    evaluated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT concept_relation_automatic_evaluations_input_unique
        UNIQUE (pair_key, input_fingerprint),
    CONSTRAINT concept_relation_automatic_evaluations_pair_key_check
        CHECK (pair_key <> ''),
    CONSTRAINT concept_relation_automatic_evaluations_fingerprint_check
        CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT concept_relation_automatic_evaluations_outcome_check CHECK (
        (outcome = 'RELATED' AND relation_id IS NOT NULL)
        OR (outcome = 'UNRELATED' AND relation_id IS NULL)
    ),
    CONSTRAINT concept_relation_automatic_evaluations_model_check
        CHECK (model_configuration_version > 0 AND text_model <> '')
);

CREATE TABLE concept_relation_discovery_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_revision_id uuid UNIQUE
        REFERENCES ai_analysis_revisions (id) ON DELETE CASCADE,
    concept_id uuid UNIQUE REFERENCES concepts (id) ON DELETE CASCADE,
    generation bigint NOT NULL DEFAULT 1,
    enqueued_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    last_failure_message text,
    CONSTRAINT concept_relation_discovery_queue_single_trigger_check CHECK (
        (analysis_revision_id IS NOT NULL)::integer
        + (concept_id IS NOT NULL)::integer = 1
    ),
    CONSTRAINT concept_relation_discovery_queue_lifecycle_check CHECK (
        processed_at IS NULL OR processed_at >= enqueued_at
    ),
    CONSTRAINT concept_relation_discovery_queue_generation_check
        CHECK (generation > 0)
);

CREATE INDEX concept_relation_discovery_queue_pending_idx
    ON concept_relation_discovery_queue (enqueued_at, id)
    WHERE processed_at IS NULL;

INSERT INTO concept_relation_discovery_queue (analysis_revision_id)
SELECT analysis.id
  FROM ai_analysis_revisions AS analysis
  INNER JOIN records AS record
    ON record.current_analysis_revision_id = analysis.id
   AND record.archived_at IS NULL
 WHERE analysis.status = 'ACTIVE'
ON CONFLICT (analysis_revision_id) DO NOTHING;

COMMIT;

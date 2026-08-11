BEGIN;

CREATE TYPE duplicate_source_type AS ENUM ('ORIGINAL', 'KNOWLEDGE_POINT');
CREATE TYPE duplicate_detection_kind AS ENUM ('EXACT', 'SEMANTIC');
CREATE TYPE duplicate_suggestion_status AS ENUM (
    'PENDING_REVIEW',
    'ACCEPTED',
    'REJECTED',
    'REMOVED'
);

CREATE TABLE duplicate_suggestions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_a_type duplicate_source_type NOT NULL,
    source_a_id uuid NOT NULL,
    source_a_record_id uuid NOT NULL
        REFERENCES records (id) ON DELETE CASCADE,
    source_a_fingerprint text NOT NULL,
    source_b_type duplicate_source_type NOT NULL,
    source_b_id uuid NOT NULL,
    source_b_record_id uuid NOT NULL
        REFERENCES records (id) ON DELETE CASCADE,
    source_b_fingerprint text NOT NULL,
    detection_kind duplicate_detection_kind NOT NULL,
    similarity_score double precision NOT NULL,
    reason text NOT NULL,
    status duplicate_suggestion_status NOT NULL DEFAULT 'PENDING_REVIEW',
    primary_source_id uuid,
    configuration_version integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    CONSTRAINT duplicate_suggestions_distinct_source_check CHECK (
        source_a_id <> source_b_id
        AND source_a_record_id <> source_b_record_id
    ),
    CONSTRAINT duplicate_suggestions_same_source_type_check
        CHECK (source_a_type = source_b_type),
    CONSTRAINT duplicate_suggestions_fingerprint_check CHECK (
        source_a_fingerprint ~ '^[0-9a-f]{64}$'
        AND source_b_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT duplicate_suggestions_score_check
        CHECK (similarity_score BETWEEN 0 AND 1),
    CONSTRAINT duplicate_suggestions_reason_check CHECK (reason <> ''),
    CONSTRAINT duplicate_suggestions_model_check CHECK (
        (detection_kind = 'EXACT' AND similarity_score = 1)
        OR detection_kind = 'SEMANTIC'
    ),
    CONSTRAINT duplicate_suggestions_resolution_check CHECK (
        (status = 'PENDING_REVIEW'
            AND primary_source_id IS NULL
            AND decided_at IS NULL)
        OR (status = 'REJECTED'
            AND primary_source_id IS NULL
            AND decided_at IS NOT NULL)
        OR (status IN ('ACCEPTED', 'REMOVED')
            AND primary_source_id IN (source_a_id, source_b_id)
            AND decided_at IS NOT NULL)
    ),
    CONSTRAINT duplicate_suggestions_identity_unique UNIQUE (
        detection_kind,
        source_a_type,
        source_a_id,
        source_a_fingerprint,
        source_b_type,
        source_b_id,
        source_b_fingerprint
    )
);

CREATE INDEX duplicate_suggestions_review_idx
    ON duplicate_suggestions (status, created_at DESC, id DESC);

CREATE INDEX duplicate_suggestions_source_a_idx
    ON duplicate_suggestions (source_a_type, source_a_id);

CREATE INDEX duplicate_suggestions_source_b_idx
    ON duplicate_suggestions (source_b_type, source_b_id);

CREATE TABLE duplicate_consolidations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    suggestion_id uuid NOT NULL UNIQUE
        REFERENCES duplicate_suggestions (id) ON DELETE CASCADE,
    primary_source_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    CONSTRAINT duplicate_consolidations_lifecycle_check
        CHECK (removed_at IS NULL OR removed_at >= created_at)
);

CREATE FUNCTION validate_duplicate_consolidation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    suggestion duplicate_suggestions%ROWTYPE;
BEGIN
    SELECT *
      INTO suggestion
      FROM duplicate_suggestions
     WHERE id = NEW.suggestion_id;

    IF suggestion.id IS NULL
       OR NOT (
           (suggestion.status = 'ACCEPTED' AND NEW.removed_at IS NULL)
           OR (suggestion.status = 'REMOVED' AND NEW.removed_at IS NOT NULL)
       )
       OR NEW.primary_source_id NOT IN (
           suggestion.source_a_id,
           suggestion.source_b_id
       ) THEN
        RAISE EXCEPTION 'duplicate consolidation must reference an accepted suggestion primary source'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'duplicate_consolidations_accepted_suggestion';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER duplicate_consolidations_validate
BEFORE INSERT ON duplicate_consolidations
FOR EACH ROW
EXECUTE FUNCTION validate_duplicate_consolidation();

COMMIT;

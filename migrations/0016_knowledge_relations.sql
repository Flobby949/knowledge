BEGIN;

CREATE TYPE knowledge_relation_type AS ENUM (
    'SIMILAR',
    'CONTRASTS',
    'PREREQUISITE',
    'EXTENDS',
    'APPLIES',
    'ANALOGY'
);

CREATE TYPE relation_suggestion_status AS ENUM (
    'PENDING_REVIEW',
    'CONFIRMED',
    'REJECTED',
    'REMOVED'
);

CREATE TYPE relation_evidence_side AS ENUM ('SOURCE', 'TARGET');

CREATE TABLE relation_suggestions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_key text NOT NULL,
    input_fingerprint text NOT NULL,
    source_knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    target_knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    source_content_fingerprint text NOT NULL,
    target_content_fingerprint text NOT NULL,
    relation_type knowledge_relation_type NOT NULL,
    description text NOT NULL,
    reason text NOT NULL,
    confidence double precision NOT NULL,
    model_configuration_version integer NOT NULL,
    text_model text NOT NULL,
    status relation_suggestion_status NOT NULL DEFAULT 'PENDING_REVIEW',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    CONSTRAINT relation_suggestions_distinct_points_check
        CHECK (source_knowledge_point_id <> target_knowledge_point_id),
    CONSTRAINT relation_suggestions_pair_key_check CHECK (pair_key <> ''),
    CONSTRAINT relation_suggestions_fingerprint_check CHECK (
        input_fingerprint ~ '^[0-9a-f]{64}$'
        AND source_content_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_content_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT relation_suggestions_description_check CHECK (description <> ''),
    CONSTRAINT relation_suggestions_reason_check CHECK (reason <> ''),
    CONSTRAINT relation_suggestions_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
    CONSTRAINT relation_suggestions_model_check CHECK (
        model_configuration_version > 0
        AND text_model <> ''
    ),
    CONSTRAINT relation_suggestions_decision_check CHECK (
        (status = 'PENDING_REVIEW' AND decided_at IS NULL)
        OR (status <> 'PENDING_REVIEW' AND decided_at IS NOT NULL)
    ),
    CONSTRAINT relation_suggestions_input_unique
        UNIQUE (pair_key, input_fingerprint)
);

CREATE INDEX relation_suggestions_review_idx
    ON relation_suggestions (status, confidence DESC, created_at DESC, id DESC);

CREATE TABLE relation_suggestion_evidence (
    suggestion_id uuid NOT NULL
        REFERENCES relation_suggestions (id) ON DELETE CASCADE,
    evidence_span_id uuid NOT NULL
        REFERENCES evidence_spans (id) ON DELETE CASCADE,
    side relation_evidence_side NOT NULL,
    PRIMARY KEY (suggestion_id, evidence_span_id),
    CONSTRAINT relation_suggestion_evidence_side_unique
        UNIQUE (suggestion_id, side, evidence_span_id)
);

CREATE FUNCTION validate_relation_suggestion_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_point_id uuid;
    actual_point_id uuid;
BEGIN
    SELECT CASE NEW.side
               WHEN 'SOURCE' THEN suggestion.source_knowledge_point_id
               ELSE suggestion.target_knowledge_point_id
           END
      INTO expected_point_id
      FROM relation_suggestions AS suggestion
     WHERE suggestion.id = NEW.suggestion_id;

    SELECT evidence.knowledge_point_id
      INTO actual_point_id
      FROM evidence_spans AS evidence
     WHERE evidence.id = NEW.evidence_span_id;

    IF expected_point_id IS NULL OR actual_point_id <> expected_point_id THEN
        RAISE EXCEPTION 'relation evidence must belong to the matching endpoint'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'relation_suggestion_evidence_endpoint';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER relation_suggestion_evidence_validate
BEFORE INSERT OR UPDATE ON relation_suggestion_evidence
FOR EACH ROW
EXECUTE FUNCTION validate_relation_suggestion_evidence();

CREATE TABLE knowledge_relations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    suggestion_id uuid NOT NULL UNIQUE
        REFERENCES relation_suggestions (id) ON DELETE CASCADE,
    source_knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    target_knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    relation_type knowledge_relation_type NOT NULL,
    description text NOT NULL,
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    CONSTRAINT knowledge_relations_distinct_points_check
        CHECK (source_knowledge_point_id <> target_knowledge_point_id),
    CONSTRAINT knowledge_relations_description_check CHECK (description <> ''),
    CONSTRAINT knowledge_relations_lifecycle_check
        CHECK (removed_at IS NULL OR removed_at >= confirmed_at)
);

CREATE INDEX knowledge_relations_active_source_idx
    ON knowledge_relations (source_knowledge_point_id, confirmed_at DESC)
    WHERE removed_at IS NULL;

CREATE INDEX knowledge_relations_active_target_idx
    ON knowledge_relations (target_knowledge_point_id, confirmed_at DESC)
    WHERE removed_at IS NULL;

CREATE FUNCTION validate_knowledge_relation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    suggestion relation_suggestions%ROWTYPE;
BEGIN
    SELECT *
      INTO suggestion
      FROM relation_suggestions
     WHERE id = NEW.suggestion_id;

    IF suggestion.id IS NULL
       OR NOT (
           (suggestion.status = 'CONFIRMED' AND NEW.removed_at IS NULL)
           OR (suggestion.status = 'REMOVED' AND NEW.removed_at IS NOT NULL)
       )
       OR NEW.source_knowledge_point_id <> suggestion.source_knowledge_point_id
       OR NEW.target_knowledge_point_id <> suggestion.target_knowledge_point_id THEN
        RAISE EXCEPTION 'knowledge relation must reference its confirmed suggestion endpoints'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'knowledge_relations_confirmed_suggestion';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_relations_validate
BEFORE INSERT ON knowledge_relations
FOR EACH ROW
EXECUTE FUNCTION validate_knowledge_relation();

COMMIT;

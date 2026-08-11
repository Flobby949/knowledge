BEGIN;

CREATE TYPE concept_candidate_scan_status AS ENUM (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED'
);

CREATE TYPE concept_candidate_scan_outcome AS ENUM (
    'CANDIDATE',
    'NO_SUGGESTION',
    'DUPLICATE'
);

CREATE TYPE concept_candidate_review_status AS ENUM (
    'PENDING',
    'ACCEPTED',
    'REJECTED'
);

CREATE TABLE concept_candidate_scans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    input_fingerprint text NOT NULL,
    input_count smallint NOT NULL,
    model_configuration_version integer NOT NULL,
    text_model text NOT NULL,
    status concept_candidate_scan_status NOT NULL DEFAULT 'QUEUED',
    outcome concept_candidate_scan_outcome,
    outcome_reason text,
    attempt_count smallint NOT NULL DEFAULT 1,
    failure_code text,
    failure_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    CONSTRAINT concept_candidate_scans_fingerprint_check CHECK (
        input_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT concept_candidate_scans_input_count_check CHECK (
        input_count BETWEEN 2 AND 12
    ),
    CONSTRAINT concept_candidate_scans_model_check CHECK (
        model_configuration_version > 0 AND text_model <> ''
    ),
    CONSTRAINT concept_candidate_scans_attempt_check CHECK (
        attempt_count BETWEEN 1 AND 2
    ),
    CONSTRAINT concept_candidate_scans_state_check CHECK (
        (status = 'QUEUED'
            AND started_at IS NULL
            AND completed_at IS NULL
            AND outcome IS NULL
            AND failure_code IS NULL
            AND failure_message IS NULL)
        OR (status = 'RUNNING'
            AND started_at IS NOT NULL
            AND completed_at IS NULL
            AND outcome IS NULL
            AND failure_code IS NULL
            AND failure_message IS NULL)
        OR (status = 'SUCCEEDED'
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND outcome IS NOT NULL
            AND failure_code IS NULL
            AND failure_message IS NULL)
        OR (status = 'FAILED'
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND outcome IS NULL
            AND failure_code IS NOT NULL
            AND failure_code <> ''
            AND failure_message IS NOT NULL
            AND failure_message <> '')
    ),
    CONSTRAINT concept_candidate_scans_outcome_check CHECK (
        (outcome IS NULL AND outcome_reason IS NULL)
        OR (outcome = 'CANDIDATE' AND outcome_reason IS NULL)
        OR (outcome IN ('NO_SUGGESTION', 'DUPLICATE')
            AND outcome_reason IS NOT NULL
            AND outcome_reason <> '')
    )
);

CREATE TABLE concept_candidate_inputs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id uuid NOT NULL
        REFERENCES concept_candidate_scans (id) ON DELETE CASCADE,
    knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    position smallint NOT NULL,
    record_title_snapshot text NOT NULL,
    title_snapshot text NOT NULL,
    body_snapshot text NOT NULL,
    evidence_snapshot jsonb NOT NULL,
    content_fingerprint text NOT NULL,
    CONSTRAINT concept_candidate_inputs_position_check CHECK (
        position BETWEEN 1 AND 12
    ),
    CONSTRAINT concept_candidate_inputs_content_check CHECK (
        record_title_snapshot <> ''
        AND title_snapshot <> ''
        AND body_snapshot <> ''
    ),
    CONSTRAINT concept_candidate_inputs_evidence_check CHECK (
        jsonb_typeof(evidence_snapshot) = 'array'
        AND jsonb_array_length(evidence_snapshot) > 0
    ),
    CONSTRAINT concept_candidate_inputs_fingerprint_check CHECK (
        content_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT concept_candidate_inputs_point_unique
        UNIQUE (scan_id, knowledge_point_id),
    CONSTRAINT concept_candidate_inputs_position_unique
        UNIQUE (scan_id, position)
);

CREATE TABLE concept_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id uuid NOT NULL UNIQUE
        REFERENCES concept_candidate_scans (id) ON DELETE CASCADE,
    candidate_fingerprint text NOT NULL,
    suggested_name text NOT NULL,
    normalized_name text COLLATE "C" NOT NULL,
    suggested_description text NOT NULL,
    reason text NOT NULL,
    review_status concept_candidate_review_status NOT NULL DEFAULT 'PENDING',
    accepted_concept_id uuid REFERENCES concepts (id) ON DELETE RESTRICT,
    confirmed_name text,
    confirmed_description text,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT concept_candidates_fingerprint_check CHECK (
        candidate_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT concept_candidates_content_check CHECK (
        suggested_name <> ''
        AND normalized_name <> ''
        AND suggested_description <> ''
        AND reason <> ''
    ),
    CONSTRAINT concept_candidates_review_check CHECK (
        (review_status = 'PENDING'
            AND accepted_concept_id IS NULL
            AND confirmed_name IS NULL
            AND confirmed_description IS NULL
            AND decided_at IS NULL)
        OR (review_status = 'ACCEPTED'
            AND accepted_concept_id IS NOT NULL
            AND confirmed_name IS NOT NULL
            AND confirmed_name <> ''
            AND confirmed_description IS NOT NULL
            AND confirmed_description <> ''
            AND decided_at IS NOT NULL)
        OR (review_status = 'REJECTED'
            AND accepted_concept_id IS NULL
            AND confirmed_name IS NULL
            AND confirmed_description IS NULL
            AND decided_at IS NOT NULL)
    )
);

CREATE TABLE concept_candidate_members (
    candidate_id uuid NOT NULL
        REFERENCES concept_candidates (id) ON DELETE CASCADE,
    input_id uuid NOT NULL
        REFERENCES concept_candidate_inputs (id) ON DELETE CASCADE,
    position smallint NOT NULL,
    PRIMARY KEY (candidate_id, input_id),
    CONSTRAINT concept_candidate_members_position_check CHECK (position >= 1),
    CONSTRAINT concept_candidate_members_position_unique
        UNIQUE (candidate_id, position)
);

CREATE TABLE concept_candidate_decision_members (
    candidate_id uuid NOT NULL
        REFERENCES concept_candidates (id) ON DELETE CASCADE,
    input_id uuid NOT NULL
        REFERENCES concept_candidate_inputs (id) ON DELETE CASCADE,
    concept_membership_id uuid NOT NULL UNIQUE
        REFERENCES concept_memberships (id) ON DELETE RESTRICT,
    position smallint NOT NULL,
    PRIMARY KEY (candidate_id, input_id),
    CONSTRAINT concept_candidate_decision_members_position_check
        CHECK (position >= 1),
    CONSTRAINT concept_candidate_decision_members_position_unique
        UNIQUE (candidate_id, position)
);

CREATE FUNCTION validate_concept_candidate_member_input()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_scan_id uuid;
    input_scan_id uuid;
BEGIN
    SELECT scan_id INTO candidate_scan_id
      FROM concept_candidates
     WHERE id = NEW.candidate_id;

    SELECT scan_id INTO input_scan_id
      FROM concept_candidate_inputs
     WHERE id = NEW.input_id;

    IF candidate_scan_id IS NULL
       OR input_scan_id IS NULL
       OR candidate_scan_id <> input_scan_id THEN
        RAISE EXCEPTION 'candidate member must belong to its scan input'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_candidate_member_input';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_candidate_members_validate
BEFORE INSERT OR UPDATE ON concept_candidate_members
FOR EACH ROW
EXECUTE FUNCTION validate_concept_candidate_member_input();

CREATE TRIGGER concept_candidate_decision_members_validate
BEFORE INSERT OR UPDATE ON concept_candidate_decision_members
FOR EACH ROW
EXECUTE FUNCTION validate_concept_candidate_member_input();

CREATE FUNCTION prevent_concept_candidate_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'concept candidate snapshots are immutable';
END;
$$;

CREATE TRIGGER concept_candidate_inputs_immutable
BEFORE UPDATE ON concept_candidate_inputs
FOR EACH ROW
EXECUTE FUNCTION prevent_concept_candidate_snapshot_update();

CREATE TRIGGER concept_candidate_members_immutable
BEFORE UPDATE ON concept_candidate_members
FOR EACH ROW
EXECUTE FUNCTION prevent_concept_candidate_snapshot_update();

CREATE TRIGGER concept_candidate_decision_members_immutable
BEFORE UPDATE ON concept_candidate_decision_members
FOR EACH ROW
EXECUTE FUNCTION prevent_concept_candidate_snapshot_update();

CREATE FUNCTION validate_concept_candidate_review_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.scan_id IS DISTINCT FROM OLD.scan_id
       OR NEW.candidate_fingerprint IS DISTINCT FROM OLD.candidate_fingerprint
       OR NEW.suggested_name IS DISTINCT FROM OLD.suggested_name
       OR NEW.normalized_name IS DISTINCT FROM OLD.normalized_name
       OR NEW.suggested_description IS DISTINCT FROM OLD.suggested_description
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'concept candidate suggestion is immutable';
    END IF;

    IF OLD.review_status <> 'PENDING'
       OR NEW.review_status NOT IN ('ACCEPTED', 'REJECTED') THEN
        RAISE EXCEPTION 'concept candidate review is final';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_candidates_review_transition
BEFORE UPDATE ON concept_candidates
FOR EACH ROW
EXECUTE FUNCTION validate_concept_candidate_review_transition();

CREATE INDEX concept_candidate_scans_status_idx
    ON concept_candidate_scans (status, created_at DESC, id DESC);
CREATE INDEX concept_candidate_scans_fingerprint_idx
    ON concept_candidate_scans (input_fingerprint, created_at DESC);
CREATE INDEX concept_candidate_inputs_scan_idx
    ON concept_candidate_inputs (scan_id, position);
CREATE INDEX concept_candidates_review_idx
    ON concept_candidates (review_status, created_at DESC, id DESC);
CREATE INDEX concept_candidates_fingerprint_idx
    ON concept_candidates (candidate_fingerprint, created_at DESC);

COMMIT;

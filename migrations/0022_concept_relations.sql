BEGIN;

ALTER TABLE concept_memberships
    DROP CONSTRAINT concept_memberships_knowledge_point_id_fkey,
    ADD CONSTRAINT concept_memberships_knowledge_point_id_fkey
        FOREIGN KEY (knowledge_point_id)
        REFERENCES knowledge_points (id) ON DELETE CASCADE;

ALTER TABLE concept_activity
    DROP CONSTRAINT concept_activity_membership_id_fkey,
    ADD CONSTRAINT concept_activity_membership_id_fkey
        FOREIGN KEY (membership_id)
        REFERENCES concept_memberships (id) ON DELETE CASCADE;

ALTER TABLE concept_candidate_decision_members
    DROP CONSTRAINT concept_candidate_decision_members_concept_membership_id_fkey,
    ADD CONSTRAINT concept_candidate_decision_members_concept_membership_id_fkey
        FOREIGN KEY (concept_membership_id)
        REFERENCES concept_memberships (id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION protect_concept_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('knowledge.permanent_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'concept activity is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'concept_activity_immutable';
END;
$$;

CREATE TABLE concept_relation_suggestions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_key text NOT NULL,
    input_fingerprint text NOT NULL,
    source_concept_id uuid NOT NULL,
    target_concept_id uuid NOT NULL,
    source_concept_revision_id uuid NOT NULL,
    target_concept_revision_id uuid NOT NULL,
    source_membership_fingerprint text NOT NULL,
    target_membership_fingerprint text NOT NULL,
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
    CONSTRAINT concept_relation_suggestions_source_revision_fk
        FOREIGN KEY (source_concept_id, source_concept_revision_id)
        REFERENCES concept_revisions (concept_id, id) ON DELETE RESTRICT,
    CONSTRAINT concept_relation_suggestions_target_revision_fk
        FOREIGN KEY (target_concept_id, target_concept_revision_id)
        REFERENCES concept_revisions (concept_id, id) ON DELETE RESTRICT,
    CONSTRAINT concept_relation_suggestions_distinct_concepts_check
        CHECK (source_concept_id <> target_concept_id),
    CONSTRAINT concept_relation_suggestions_symmetric_canonical_check CHECK (
        relation_type NOT IN ('SIMILAR', 'CONTRASTS', 'ANALOGY')
        OR source_concept_id < target_concept_id
    ),
    CONSTRAINT concept_relation_suggestions_pair_key_check CHECK (
        pair_key <> ''
    ),
    CONSTRAINT concept_relation_suggestions_fingerprint_check CHECK (
        input_fingerprint ~ '^[0-9a-f]{64}$'
        AND source_membership_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_membership_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT concept_relation_suggestions_content_check CHECK (
        description <> '' AND reason <> ''
    ),
    CONSTRAINT concept_relation_suggestions_confidence_check CHECK (
        confidence BETWEEN 0 AND 1
    ),
    CONSTRAINT concept_relation_suggestions_model_check CHECK (
        model_configuration_version > 0 AND text_model <> ''
    ),
    CONSTRAINT concept_relation_suggestions_lifecycle_check CHECK (
        updated_at >= created_at
        AND (
            (status = 'PENDING_REVIEW' AND decided_at IS NULL)
            OR (status <> 'PENDING_REVIEW' AND decided_at IS NOT NULL)
        )
    ),
    CONSTRAINT concept_relation_suggestions_input_unique
        UNIQUE (pair_key, input_fingerprint)
);

CREATE INDEX concept_relation_suggestions_review_idx
    ON concept_relation_suggestions (
        status,
        confidence DESC,
        created_at DESC,
        id DESC
    );

CREATE INDEX concept_relation_suggestions_source_idx
    ON concept_relation_suggestions (source_concept_id, created_at DESC, id DESC);

CREATE INDEX concept_relation_suggestions_target_idx
    ON concept_relation_suggestions (target_concept_id, created_at DESC, id DESC);

CREATE FUNCTION protect_concept_relation_suggestion_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'concept relation suggestion history is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relation_suggestions_history_immutable';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.pair_key IS DISTINCT FROM OLD.pair_key
       OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
       OR NEW.source_concept_id IS DISTINCT FROM OLD.source_concept_id
       OR NEW.target_concept_id IS DISTINCT FROM OLD.target_concept_id
       OR NEW.source_concept_revision_id
            IS DISTINCT FROM OLD.source_concept_revision_id
       OR NEW.target_concept_revision_id
            IS DISTINCT FROM OLD.target_concept_revision_id
       OR NEW.source_membership_fingerprint
            IS DISTINCT FROM OLD.source_membership_fingerprint
       OR NEW.target_membership_fingerprint
            IS DISTINCT FROM OLD.target_membership_fingerprint
       OR NEW.relation_type IS DISTINCT FROM OLD.relation_type
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.model_configuration_version
            IS DISTINCT FROM OLD.model_configuration_version
       OR NEW.text_model IS DISTINCT FROM OLD.text_model
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'concept relation suggestion snapshot is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relation_suggestions_snapshot_immutable';
    END IF;

    IF NOT (
           NEW.status = OLD.status
           OR (OLD.status = 'PENDING_REVIEW'
               AND NEW.status IN ('CONFIRMED', 'REJECTED'))
           OR (OLD.status = 'CONFIRMED' AND NEW.status = 'REMOVED')
       )
       OR (OLD.decided_at IS NOT NULL
           AND NEW.decided_at IS DISTINCT FROM OLD.decided_at)
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'concept relation suggestion decision history is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relation_suggestions_decision_immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_relation_suggestions_protect_snapshot
BEFORE UPDATE OR DELETE ON concept_relation_suggestions
FOR EACH ROW
EXECUTE FUNCTION protect_concept_relation_suggestion_snapshot();

CREATE TABLE concept_relations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    suggestion_id uuid NOT NULL UNIQUE
        REFERENCES concept_relation_suggestions (id) ON DELETE CASCADE,
    source_concept_id uuid NOT NULL
        REFERENCES concepts (id) ON DELETE RESTRICT,
    target_concept_id uuid NOT NULL
        REFERENCES concepts (id) ON DELETE RESTRICT,
    relation_type knowledge_relation_type NOT NULL,
    description text NOT NULL,
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    CONSTRAINT concept_relations_distinct_concepts_check
        CHECK (source_concept_id <> target_concept_id),
    CONSTRAINT concept_relations_symmetric_canonical_check CHECK (
        relation_type NOT IN ('SIMILAR', 'CONTRASTS', 'ANALOGY')
        OR source_concept_id < target_concept_id
    ),
    CONSTRAINT concept_relations_description_check CHECK (description <> ''),
    CONSTRAINT concept_relations_lifecycle_check CHECK (
        removed_at IS NULL OR removed_at >= confirmed_at
    )
);

CREATE UNIQUE INDEX concept_relations_active_identity_unique
    ON concept_relations (
        source_concept_id,
        target_concept_id,
        relation_type
    )
    WHERE removed_at IS NULL;

CREATE INDEX concept_relations_active_source_idx
    ON concept_relations (source_concept_id, confirmed_at DESC, id DESC)
    WHERE removed_at IS NULL;

CREATE INDEX concept_relations_active_target_idx
    ON concept_relations (target_concept_id, confirmed_at DESC, id DESC)
    WHERE removed_at IS NULL;

CREATE FUNCTION protect_concept_relation_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'concept relation history is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relations_history_immutable';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.suggestion_id IS DISTINCT FROM OLD.suggestion_id
       OR NEW.source_concept_id IS DISTINCT FROM OLD.source_concept_id
       OR NEW.target_concept_id IS DISTINCT FROM OLD.target_concept_id
       OR NEW.relation_type IS DISTINCT FROM OLD.relation_type
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR (OLD.removed_at IS NOT NULL
           AND NEW.removed_at IS DISTINCT FROM OLD.removed_at) THEN
        RAISE EXCEPTION 'concept relation identity is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relations_identity_immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_relations_protect_identity
BEFORE UPDATE OR DELETE ON concept_relations
FOR EACH ROW
EXECUTE FUNCTION protect_concept_relation_identity();

CREATE FUNCTION validate_concept_relation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    suggestion concept_relation_suggestions%ROWTYPE;
    endpoints_match boolean;
BEGIN
    SELECT *
      INTO suggestion
      FROM concept_relation_suggestions
     WHERE id = NEW.suggestion_id;

    IF NEW.relation_type IN ('SIMILAR', 'CONTRASTS', 'ANALOGY') THEN
        endpoints_match := (
            NEW.source_concept_id = suggestion.source_concept_id
            AND NEW.target_concept_id = suggestion.target_concept_id
        ) OR (
            NEW.source_concept_id = suggestion.target_concept_id
            AND NEW.target_concept_id = suggestion.source_concept_id
        );
    ELSE
        endpoints_match := (
            NEW.source_concept_id = suggestion.source_concept_id
            AND NEW.target_concept_id = suggestion.target_concept_id
        );
    END IF;

    IF suggestion.id IS NULL
       OR NOT (
           (suggestion.status = 'CONFIRMED' AND NEW.removed_at IS NULL)
           OR (suggestion.status = 'REMOVED' AND NEW.removed_at IS NOT NULL)
       )
       OR NOT COALESCE(endpoints_match, false) THEN
        RAISE EXCEPTION 'concept relation must reference its confirmed suggestion endpoints'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relations_confirmed_suggestion';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_relations_validate
BEFORE INSERT OR UPDATE ON concept_relations
FOR EACH ROW
EXECUTE FUNCTION validate_concept_relation();

COMMIT;

BEGIN;

ALTER TABLE concept_relations
    ADD COLUMN confirmation_source text NOT NULL DEFAULT 'AI_SUGGESTION',
    ADD COLUMN source_concept_revision_id uuid,
    ADD COLUMN target_concept_revision_id uuid,
    ADD COLUMN source_membership_fingerprint text,
    ADD COLUMN target_membership_fingerprint text,
    ALTER COLUMN suggestion_id DROP NOT NULL;

UPDATE concept_relations AS relation
   SET source_concept_revision_id = CASE
           WHEN relation.source_concept_id = suggestion.source_concept_id
               THEN suggestion.source_concept_revision_id
           ELSE suggestion.target_concept_revision_id
       END,
       target_concept_revision_id = CASE
           WHEN relation.target_concept_id = suggestion.target_concept_id
               THEN suggestion.target_concept_revision_id
           ELSE suggestion.source_concept_revision_id
       END,
       source_membership_fingerprint = CASE
           WHEN relation.source_concept_id = suggestion.source_concept_id
               THEN suggestion.source_membership_fingerprint
           ELSE suggestion.target_membership_fingerprint
       END,
       target_membership_fingerprint = CASE
           WHEN relation.target_concept_id = suggestion.target_concept_id
               THEN suggestion.target_membership_fingerprint
           ELSE suggestion.source_membership_fingerprint
       END
  FROM concept_relation_suggestions AS suggestion
 WHERE suggestion.id = relation.suggestion_id;

ALTER TABLE concept_relations
    ALTER COLUMN source_concept_revision_id SET NOT NULL,
    ALTER COLUMN target_concept_revision_id SET NOT NULL,
    ALTER COLUMN source_membership_fingerprint SET NOT NULL,
    ALTER COLUMN target_membership_fingerprint SET NOT NULL,
    ADD CONSTRAINT concept_relations_confirmation_source_check CHECK (
        (confirmation_source = 'AI_SUGGESTION' AND suggestion_id IS NOT NULL)
        OR (confirmation_source = 'USER' AND suggestion_id IS NULL)
    ),
    ADD CONSTRAINT concept_relations_source_revision_fk
        FOREIGN KEY (source_concept_id, source_concept_revision_id)
        REFERENCES concept_revisions (concept_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT concept_relations_target_revision_fk
        FOREIGN KEY (target_concept_id, target_concept_revision_id)
        REFERENCES concept_revisions (concept_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT concept_relations_membership_fingerprint_check CHECK (
        source_membership_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_membership_fingerprint ~ '^[0-9a-f]{64}$'
    );

CREATE OR REPLACE FUNCTION protect_concept_relation_identity()
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
       OR NEW.confirmation_source IS DISTINCT FROM OLD.confirmation_source
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

CREATE OR REPLACE FUNCTION validate_concept_relation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    suggestion concept_relation_suggestions%ROWTYPE;
    endpoints_match boolean;
BEGIN
    IF NEW.confirmation_source = 'USER' THEN
        IF NEW.suggestion_id IS NOT NULL THEN
            RAISE EXCEPTION 'user Concept relation cannot reference an AI suggestion'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'concept_relations_confirmation_source_check';
        END IF;

        RETURN NEW;
    END IF;

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

    IF NEW.source_concept_revision_id IS NULL THEN
        NEW.source_concept_revision_id := CASE
            WHEN NEW.source_concept_id = suggestion.source_concept_id
                THEN suggestion.source_concept_revision_id
            ELSE suggestion.target_concept_revision_id
        END;
    END IF;
    IF NEW.target_concept_revision_id IS NULL THEN
        NEW.target_concept_revision_id := CASE
            WHEN NEW.target_concept_id = suggestion.target_concept_id
                THEN suggestion.target_concept_revision_id
            ELSE suggestion.source_concept_revision_id
        END;
    END IF;
    IF NEW.source_membership_fingerprint IS NULL THEN
        NEW.source_membership_fingerprint := CASE
            WHEN NEW.source_concept_id = suggestion.source_concept_id
                THEN suggestion.source_membership_fingerprint
            ELSE suggestion.target_membership_fingerprint
        END;
    END IF;
    IF NEW.target_membership_fingerprint IS NULL THEN
        NEW.target_membership_fingerprint := CASE
            WHEN NEW.target_concept_id = suggestion.target_concept_id
                THEN suggestion.target_membership_fingerprint
            ELSE suggestion.source_membership_fingerprint
        END;
    END IF;

    IF suggestion.id IS NULL
       OR NOT (
           (suggestion.status = 'CONFIRMED' AND NEW.removed_at IS NULL)
           OR (suggestion.status = 'REMOVED' AND NEW.removed_at IS NOT NULL)
       )
       OR NOT COALESCE(endpoints_match, false)
       OR NEW.source_concept_revision_id IS DISTINCT FROM (CASE
            WHEN NEW.source_concept_id = suggestion.source_concept_id
                THEN suggestion.source_concept_revision_id
            ELSE suggestion.target_concept_revision_id
          END)
       OR NEW.target_concept_revision_id IS DISTINCT FROM (CASE
            WHEN NEW.target_concept_id = suggestion.target_concept_id
                THEN suggestion.target_concept_revision_id
            ELSE suggestion.source_concept_revision_id
          END)
       OR NEW.source_membership_fingerprint IS DISTINCT FROM (CASE
            WHEN NEW.source_concept_id = suggestion.source_concept_id
                THEN suggestion.source_membership_fingerprint
            ELSE suggestion.target_membership_fingerprint
          END)
       OR NEW.target_membership_fingerprint IS DISTINCT FROM (CASE
            WHEN NEW.target_concept_id = suggestion.target_concept_id
                THEN suggestion.target_membership_fingerprint
            ELSE suggestion.source_membership_fingerprint
          END) THEN
        RAISE EXCEPTION 'Concept relation must preserve its confirmation snapshot'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_relations_confirmation_snapshot';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

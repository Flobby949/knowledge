BEGIN;

CREATE TYPE concept_membership_origin AS ENUM ('USER');

CREATE TYPE concept_activity_kind AS ENUM (
    'CREATED',
    'UPDATED',
    'ARCHIVED',
    'RESTORED',
    'MEMBER_ADDED',
    'MEMBER_REMOVED',
    'MEMBER_RESTORED'
);

CREATE TABLE concepts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    current_revision_id uuid NOT NULL,
    normalized_name text COLLATE "C" NOT NULL,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT concepts_normalized_name_check CHECK (normalized_name <> ''),
    CONSTRAINT concepts_lifecycle_check CHECK (
        updated_at >= created_at
        AND (archived_at IS NULL OR archived_at >= created_at)
    ),
    CONSTRAINT concepts_normalized_name_unique UNIQUE (normalized_name)
);

CREATE TABLE concept_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id uuid NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
    revision_number integer NOT NULL,
    display_name text NOT NULL,
    normalized_name text COLLATE "C" NOT NULL,
    description text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT concept_revisions_number_check CHECK (revision_number >= 1),
    CONSTRAINT concept_revisions_name_check CHECK (
        display_name <> '' AND normalized_name <> ''
    ),
    CONSTRAINT concept_revisions_description_check CHECK (description <> ''),
    CONSTRAINT concept_revisions_number_unique
        UNIQUE (concept_id, revision_number),
    CONSTRAINT concept_revisions_concept_id_unique UNIQUE (concept_id, id)
);

ALTER TABLE concepts
    ADD CONSTRAINT concepts_current_revision_fk
    FOREIGN KEY (id, current_revision_id)
    REFERENCES concept_revisions (concept_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE concept_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id uuid NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
    knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE RESTRICT,
    origin concept_membership_origin NOT NULL DEFAULT 'USER',
    created_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    CONSTRAINT concept_memberships_lifecycle_check CHECK (
        removed_at IS NULL OR removed_at >= created_at
    ),
    CONSTRAINT concept_memberships_point_unique
        UNIQUE (concept_id, knowledge_point_id)
);

CREATE TABLE concept_activity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id uuid NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
    sequence_number integer NOT NULL,
    kind concept_activity_kind NOT NULL,
    revision_id uuid REFERENCES concept_revisions (id) ON DELETE RESTRICT,
    membership_id uuid REFERENCES concept_memberships (id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT concept_activity_sequence_check CHECK (sequence_number >= 1),
    CONSTRAINT concept_activity_sequence_unique
        UNIQUE (concept_id, sequence_number),
    CONSTRAINT concept_activity_target_check CHECK (
        (kind IN ('CREATED', 'UPDATED')
            AND revision_id IS NOT NULL
            AND membership_id IS NULL)
        OR (kind IN ('ARCHIVED', 'RESTORED')
            AND revision_id IS NULL
            AND membership_id IS NULL)
        OR (kind IN ('MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_RESTORED')
            AND revision_id IS NULL
            AND membership_id IS NOT NULL)
    )
);

CREATE INDEX concepts_active_updated_idx
    ON concepts (updated_at DESC, id DESC)
    WHERE archived_at IS NULL;
CREATE INDEX concepts_archived_updated_idx
    ON concepts (updated_at DESC, id DESC)
    WHERE archived_at IS NOT NULL;
CREATE INDEX concept_revisions_concept_idx
    ON concept_revisions (concept_id, revision_number DESC);
CREATE INDEX concept_memberships_concept_idx
    ON concept_memberships (concept_id, created_at, id);
CREATE INDEX concept_memberships_point_idx
    ON concept_memberships (knowledge_point_id, concept_id);
CREATE INDEX concept_activity_concept_idx
    ON concept_activity (concept_id, sequence_number DESC);

CREATE FUNCTION validate_concept_current_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM concept_revisions AS revision
         WHERE revision.id = NEW.current_revision_id
           AND revision.concept_id = NEW.id
           AND revision.normalized_name = NEW.normalized_name
    ) THEN
        RAISE EXCEPTION 'concept current revision must match its identity and name'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concepts_current_revision_matches';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER concepts_validate_current_revision
AFTER INSERT OR UPDATE ON concepts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_concept_current_revision();

CREATE FUNCTION protect_concept_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'concept revisions are immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'concept_revisions_immutable';
END;
$$;

CREATE TRIGGER concept_revisions_protect_history
BEFORE UPDATE OR DELETE ON concept_revisions
FOR EACH ROW
EXECUTE FUNCTION protect_concept_revision();

CREATE FUNCTION protect_concept_membership_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.concept_id IS DISTINCT FROM OLD.concept_id
       OR NEW.knowledge_point_id IS DISTINCT FROM OLD.knowledge_point_id
       OR NEW.origin IS DISTINCT FROM OLD.origin
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'concept membership identity is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_memberships_identity_immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_memberships_protect_identity
BEFORE UPDATE ON concept_memberships
FOR EACH ROW
EXECUTE FUNCTION protect_concept_membership_identity();

CREATE FUNCTION validate_concept_activity_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_concept_id uuid;
BEGIN
    IF NEW.revision_id IS NOT NULL THEN
        SELECT revision.concept_id
          INTO target_concept_id
          FROM concept_revisions AS revision
         WHERE revision.id = NEW.revision_id;
    ELSIF NEW.membership_id IS NOT NULL THEN
        SELECT membership.concept_id
          INTO target_concept_id
          FROM concept_memberships AS membership
         WHERE membership.id = NEW.membership_id;
    ELSE
        target_concept_id := NEW.concept_id;
    END IF;

    IF target_concept_id IS DISTINCT FROM NEW.concept_id THEN
        RAISE EXCEPTION 'concept activity target must belong to the concept'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'concept_activity_same_concept';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER concept_activity_validate_reference
BEFORE INSERT ON concept_activity
FOR EACH ROW
EXECUTE FUNCTION validate_concept_activity_reference();

CREATE FUNCTION protect_concept_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'concept activity is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'concept_activity_immutable';
END;
$$;

CREATE TRIGGER concept_activity_protect_history
BEFORE UPDATE OR DELETE ON concept_activity
FOR EACH ROW
EXECUTE FUNCTION protect_concept_activity();

COMMIT;

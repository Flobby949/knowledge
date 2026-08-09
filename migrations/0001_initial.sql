BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE tag_origin AS ENUM ('USER_CREATED', 'AI_CREATED');
CREATE TYPE tag_approval_status AS ENUM ('CANDIDATE', 'USER_APPROVED', 'ARCHIVED');
CREATE TYPE tag_assigned_by AS ENUM ('USER', 'AI');
CREATE TYPE tag_assignment_status AS ENUM ('ACTIVE', 'SUPPRESSED');

CREATE TABLE records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    current_fragment_revision_id uuid NOT NULL,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT records_archive_time_check
        CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE fragment_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid NOT NULL,
    revision_number integer NOT NULL,
    content text NOT NULL,
    grapheme_count smallint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fragment_revisions_record_fk
        FOREIGN KEY (record_id) REFERENCES records (id) ON DELETE CASCADE,
    CONSTRAINT fragment_revisions_number_check
        CHECK (revision_number >= 1),
    CONSTRAINT fragment_revisions_content_check
        CHECK (content <> ''),
    CONSTRAINT fragment_revisions_grapheme_count_check
        CHECK (grapheme_count BETWEEN 1 AND 1000),
    CONSTRAINT fragment_revisions_record_number_unique
        UNIQUE (record_id, revision_number),
    CONSTRAINT fragment_revisions_record_id_unique
        UNIQUE (record_id, id)
);

ALTER TABLE records
    ADD CONSTRAINT records_current_fragment_revision_fk
    FOREIGN KEY (id, current_fragment_revision_id)
    REFERENCES fragment_revisions (record_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL,
    normalized_name text COLLATE "C" NOT NULL,
    origin tag_origin NOT NULL,
    approval_status tag_approval_status NOT NULL,
    user_approved_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tags_display_name_check CHECK (display_name <> ''),
    CONSTRAINT tags_normalized_name_check CHECK (normalized_name <> ''),
    CONSTRAINT tags_user_created_candidate_check
        CHECK (origin <> 'USER_CREATED' OR approval_status <> 'CANDIDATE'),
    CONSTRAINT tags_approval_times_check CHECK (
        (approval_status = 'CANDIDATE'
            AND user_approved_at IS NULL
            AND archived_at IS NULL)
        OR (approval_status = 'USER_APPROVED'
            AND user_approved_at IS NOT NULL
            AND archived_at IS NULL)
        OR (approval_status = 'ARCHIVED'
            AND user_approved_at IS NOT NULL
            AND archived_at IS NOT NULL)
    ),
    CONSTRAINT tags_normalized_name_unique UNIQUE (normalized_name)
);

CREATE TABLE tag_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    assigned_by tag_assigned_by NOT NULL DEFAULT 'USER',
    status tag_assignment_status NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tag_assignments_record_fk
        FOREIGN KEY (record_id) REFERENCES records (id) ON DELETE CASCADE,
    CONSTRAINT tag_assignments_tag_fk
        FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE RESTRICT,
    CONSTRAINT tag_assignments_record_target_check
        CHECK (assigned_by = 'USER'),
    CONSTRAINT tag_assignments_record_status_check
        CHECK (status = 'ACTIVE'),
    CONSTRAINT tag_assignments_record_tag_unique UNIQUE (record_id, tag_id)
);

CREATE FUNCTION assert_record_has_active_user_approved_tag(target_record_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM records
        WHERE id = target_record_id
    ) AND NOT EXISTS (
        SELECT 1
        FROM tag_assignments AS assignment
        INNER JOIN tags AS tag ON tag.id = assignment.tag_id
        WHERE assignment.record_id = target_record_id
          AND assignment.assigned_by = 'USER'
          AND assignment.status = 'ACTIVE'
          AND tag.approval_status = 'USER_APPROVED'
    ) THEN
        RAISE EXCEPTION 'record % requires at least one active user-approved tag', target_record_id
            USING ERRCODE = '23514',
                  CONSTRAINT = 'records_require_active_user_approved_tag';
    END IF;
END;
$$;

CREATE FUNCTION check_record_tag_after_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM assert_record_has_active_user_approved_tag(NEW.id);
    RETURN NULL;
END;
$$;

CREATE FUNCTION check_record_tag_after_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM assert_record_has_active_user_approved_tag(OLD.record_id);
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM assert_record_has_active_user_approved_tag(OLD.record_id);
        IF NEW.record_id IS DISTINCT FROM OLD.record_id THEN
            PERFORM assert_record_has_active_user_approved_tag(NEW.record_id);
        END IF;
    ELSE
        PERFORM assert_record_has_active_user_approved_tag(NEW.record_id);
    END IF;

    RETURN NULL;
END;
$$;

CREATE FUNCTION check_record_tag_after_tag_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    affected_record_id uuid;
BEGIN
    FOR affected_record_id IN
        SELECT DISTINCT assignment.record_id
        FROM tag_assignments AS assignment
        WHERE assignment.tag_id = NEW.id
    LOOP
        PERFORM assert_record_has_active_user_approved_tag(affected_record_id);
    END LOOP;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER records_require_active_user_approved_tag_on_record
AFTER INSERT ON records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION check_record_tag_after_record_change();

CREATE CONSTRAINT TRIGGER records_require_active_user_approved_tag_on_assignment
AFTER INSERT OR UPDATE OR DELETE ON tag_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION check_record_tag_after_assignment_change();

CREATE CONSTRAINT TRIGGER records_require_active_user_approved_tag_on_tag
AFTER UPDATE ON tags
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.approval_status IS DISTINCT FROM NEW.approval_status)
EXECUTE FUNCTION check_record_tag_after_tag_change();

CREATE INDEX records_unarchived_created_at_idx
    ON records (created_at DESC, id DESC)
    WHERE archived_at IS NULL;

CREATE INDEX fragment_revisions_content_trgm_idx
    ON fragment_revisions USING gin (content gin_trgm_ops);

CREATE INDEX tags_display_name_trgm_idx
    ON tags USING gin (display_name gin_trgm_ops);

CREATE INDEX tag_assignments_active_record_idx
    ON tag_assignments (record_id, tag_id)
    WHERE status = 'ACTIVE';

CREATE INDEX tag_assignments_active_tag_idx
    ON tag_assignments (tag_id, record_id)
    WHERE status = 'ACTIVE';

COMMIT;

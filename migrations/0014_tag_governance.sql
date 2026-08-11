BEGIN;

CREATE TABLE tag_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    display_name text NOT NULL,
    normalized_name text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tag_aliases_display_name_check CHECK (display_name <> ''),
    CONSTRAINT tag_aliases_normalized_name_check CHECK (normalized_name <> ''),
    CONSTRAINT tag_aliases_normalized_name_unique UNIQUE (normalized_name)
);

CREATE INDEX tag_aliases_tag_idx ON tag_aliases (tag_id, created_at, id);
CREATE INDEX tag_aliases_display_name_trgm_idx
    ON tag_aliases USING gin (display_name gin_trgm_ops);

CREATE TABLE tag_merges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id uuid NOT NULL,
    source_tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE RESTRICT,
    target_tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    undone_at timestamptz,
    CONSTRAINT tag_merges_distinct_tags_check
        CHECK (source_tag_id <> target_tag_id),
    CONSTRAINT tag_merges_undo_time_check
        CHECK (undone_at IS NULL OR undone_at >= created_at)
);

CREATE UNIQUE INDEX tag_merges_one_active_source_idx
    ON tag_merges (source_tag_id)
    WHERE undone_at IS NULL;
CREATE INDEX tag_merges_operation_idx
    ON tag_merges (operation_id, created_at, id);
CREATE INDEX tag_merges_active_target_idx
    ON tag_merges (target_tag_id, source_tag_id)
    WHERE undone_at IS NULL;

CREATE FUNCTION resolve_tag_id(input_tag_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (
            SELECT merge.target_tag_id
              FROM tag_merges AS merge
             WHERE merge.source_tag_id = input_tag_id
               AND merge.undone_at IS NULL
        ),
        input_tag_id
    )
$$;

CREATE FUNCTION resolve_tag_name(input_normalized_name text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT resolve_tag_id(name_match.tag_id)
      FROM (
          SELECT tag.id AS tag_id, 0 AS priority
            FROM tags AS tag
           WHERE tag.normalized_name = input_normalized_name
          UNION ALL
          SELECT alias.tag_id, 1 AS priority
            FROM tag_aliases AS alias
           WHERE alias.normalized_name = input_normalized_name
      ) AS name_match
     ORDER BY name_match.priority
     LIMIT 1
$$;

CREATE FUNCTION enforce_tag_name_namespace_on_tag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('knowledge-tag-vocabulary-names', 0)
    );

    IF EXISTS (
        SELECT 1
          FROM tag_aliases AS alias
         WHERE alias.normalized_name = NEW.normalized_name
    ) THEN
        RAISE EXCEPTION 'tag name conflicts with an existing alias'
            USING ERRCODE = '23505',
                  CONSTRAINT = 'tag_vocabulary_normalized_name_unique';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tags_reserve_alias_namespace
BEFORE INSERT OR UPDATE OF normalized_name ON tags
FOR EACH ROW
EXECUTE FUNCTION enforce_tag_name_namespace_on_tag();

CREATE FUNCTION validate_tag_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_status tag_approval_status;
    target_archived_at timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('knowledge-tag-vocabulary-names', 0)
    );

    SELECT tag.approval_status, tag.archived_at
      INTO target_status, target_archived_at
      FROM tags AS tag
     WHERE tag.id = NEW.tag_id;

    IF target_status IS DISTINCT FROM 'USER_APPROVED'
       OR target_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'tag aliases require an active user-approved tag'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_aliases_require_active_approved_tag';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM tags AS tag
         WHERE tag.normalized_name = NEW.normalized_name
    ) THEN
        RAISE EXCEPTION 'tag alias conflicts with an existing tag name'
            USING ERRCODE = '23505',
                  CONSTRAINT = 'tag_vocabulary_normalized_name_unique';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tag_aliases_validate_target_and_name
BEFORE INSERT OR UPDATE OF tag_id, normalized_name ON tag_aliases
FOR EACH ROW
EXECUTE FUNCTION validate_tag_alias();

CREATE FUNCTION validate_tag_merge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_status tag_approval_status;
    source_archived_at timestamptz;
    target_status tag_approval_status;
    target_archived_at timestamptz;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.source_tag_id IS DISTINCT FROM OLD.source_tag_id
        OR NEW.target_tag_id IS DISTINCT FROM OLD.target_tag_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'tag merge identity is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_merges_identity_immutable';
    END IF;

    IF NEW.undone_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('knowledge-tag-merge-graph', 0)
    );

    SELECT tag.approval_status, tag.archived_at
      INTO source_status, source_archived_at
      FROM tags AS tag
     WHERE tag.id = NEW.source_tag_id;
    SELECT tag.approval_status, tag.archived_at
      INTO target_status, target_archived_at
      FROM tags AS tag
     WHERE tag.id = NEW.target_tag_id;

    IF source_status IS NULL OR target_status IS NULL THEN
        RETURN NEW;
    END IF;

    IF source_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'archived tags cannot be merge sources'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_merges_source_must_be_active';
    END IF;

    IF target_status IS DISTINCT FROM 'USER_APPROVED'
       OR target_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'tag merge target must be active and user-approved'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_merges_target_must_be_active_approved';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM tag_merges AS active_merge
         WHERE active_merge.source_tag_id = NEW.target_tag_id
           AND active_merge.undone_at IS NULL
    ) OR EXISTS (
        SELECT 1
          FROM tag_merges AS active_merge
         WHERE active_merge.target_tag_id = NEW.source_tag_id
           AND active_merge.undone_at IS NULL
    ) THEN
        RAISE EXCEPTION 'tag merge chains are not allowed'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_merges_no_chains';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tag_merges_validate_graph
BEFORE INSERT OR UPDATE ON tag_merges
FOR EACH ROW
EXECUTE FUNCTION validate_tag_merge();

CREATE FUNCTION protect_active_tag_governance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.approval_status <> 'USER_APPROVED' OR NEW.archived_at IS NOT NULL THEN
        IF EXISTS (
            SELECT 1
              FROM tag_aliases AS alias
             WHERE alias.tag_id = NEW.id
        ) OR EXISTS (
            SELECT 1
              FROM tag_merges AS active_merge
             WHERE active_merge.target_tag_id = NEW.id
               AND active_merge.undone_at IS NULL
        ) THEN
            RAISE EXCEPTION 'a canonical tag with aliases or merged sources must stay active'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'tag_governance_canonical_tag_must_stay_active';
        END IF;
    END IF;

    IF NEW.archived_at IS NOT NULL AND EXISTS (
        SELECT 1
          FROM tag_merges AS active_merge
         WHERE active_merge.source_tag_id = NEW.id
           AND active_merge.undone_at IS NULL
    ) THEN
        RAISE EXCEPTION 'an active merge source cannot be archived'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_governance_merge_source_must_stay_active';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tags_protect_active_governance
BEFORE UPDATE OF approval_status, archived_at ON tags
FOR EACH ROW
EXECUTE FUNCTION protect_active_tag_governance();

COMMIT;

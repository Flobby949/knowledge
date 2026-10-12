BEGIN;

ALTER TABLE tags
    ADD COLUMN parent_tag_id uuid,
    ADD CONSTRAINT tags_parent_fk
        FOREIGN KEY (parent_tag_id) REFERENCES tags (id) ON DELETE RESTRICT,
    ADD CONSTRAINT tags_parent_not_self_check
        CHECK (parent_tag_id IS NULL OR parent_tag_id <> id),
    ADD CONSTRAINT tags_parent_requires_active_approved_check CHECK (
        parent_tag_id IS NULL
        OR (approval_status = 'USER_APPROVED' AND archived_at IS NULL)
    );

CREATE INDEX tags_parent_idx
    ON tags (parent_tag_id, display_name, id)
    WHERE parent_tag_id IS NOT NULL;

-- Every tag appears once: roots start a path and children extend their
-- parent's path. path_ids and path_names end with the tag itself.
CREATE VIEW tag_hierarchy_paths AS
WITH RECURSIVE tag_path AS (
    SELECT tag.id AS tag_id,
           ARRAY[tag.id] AS path_ids,
           ARRAY[tag.display_name] AS path_names,
           1 AS depth
      FROM tags AS tag
     WHERE tag.parent_tag_id IS NULL
    UNION ALL
    SELECT child.id,
           parent.path_ids || child.id,
           parent.path_names || child.display_name,
           parent.depth + 1
      FROM tags AS child
      INNER JOIN tag_path AS parent ON child.parent_tag_id = parent.tag_id
     WHERE parent.depth < 32
)
SELECT tag_id, path_ids, path_names, depth
  FROM tag_path;

CREATE FUNCTION tag_subtree_ids(root_tag_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
AS $$
    SELECT tag_path.tag_id
      FROM tag_hierarchy_paths AS tag_path
     WHERE tag_path.path_ids && ARRAY(
         SELECT resolve_tag_id(requested.id)
           FROM unnest(root_tag_ids) AS requested(id)
     )
$$;

CREATE FUNCTION validate_tag_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status tag_approval_status;
    parent_archived_at timestamptz;
    parent_depth integer;
    creates_cycle boolean;
    subtree_height integer;
    stays_active boolean;
BEGIN
    stays_active :=
        NEW.approval_status = 'USER_APPROVED' AND NEW.archived_at IS NULL;

    IF TG_OP = 'INSERT' AND NEW.parent_tag_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.parent_tag_id IS NOT DISTINCT FROM OLD.parent_tag_id
       AND stays_active THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('knowledge-tag-hierarchy', 0)
    );

    IF NOT stays_active AND EXISTS (
        SELECT 1
          FROM tags AS child
         WHERE child.parent_tag_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'a tag with child tags must stay active and user-approved'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_hierarchy_parent_must_stay_active';
    END IF;

    IF NEW.parent_tag_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM tag_merges AS active_merge
         WHERE active_merge.source_tag_id = NEW.id
           AND active_merge.undone_at IS NULL
    ) THEN
        RAISE EXCEPTION 'an active merge source cannot join the tag hierarchy'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_hierarchy_member_must_be_canonical';
    END IF;

    SELECT tag.approval_status, tag.archived_at
      INTO parent_status, parent_archived_at
      FROM tags AS tag
     WHERE tag.id = NEW.parent_tag_id;

    IF parent_status IS DISTINCT FROM 'USER_APPROVED'
       OR parent_archived_at IS NOT NULL
       OR EXISTS (
           SELECT 1
             FROM tag_merges AS active_merge
            WHERE active_merge.source_tag_id = NEW.parent_tag_id
              AND active_merge.undone_at IS NULL
       ) THEN
        RAISE EXCEPTION 'a parent tag must be an active canonical user-approved tag'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_hierarchy_parent_must_be_active';
    END IF;

    WITH RECURSIVE ancestors AS (
        SELECT tag.id, tag.parent_tag_id, 1 AS depth
          FROM tags AS tag
         WHERE tag.id = NEW.parent_tag_id
        UNION ALL
        SELECT tag.id, tag.parent_tag_id, ancestors.depth + 1
          FROM tags AS tag
          INNER JOIN ancestors ON tag.id = ancestors.parent_tag_id
         WHERE ancestors.depth < 32
           AND ancestors.id <> NEW.id
    )
    SELECT COALESCE(max(ancestors.depth), 0),
           COALESCE(bool_or(ancestors.id = NEW.id), false)
      INTO parent_depth, creates_cycle
      FROM ancestors;

    IF creates_cycle THEN
        RAISE EXCEPTION 'a tag cannot be placed under itself or its descendants'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_hierarchy_no_cycles';
    END IF;

    WITH RECURSIVE descendants AS (
        SELECT tag.id, 1 AS depth
          FROM tags AS tag
         WHERE tag.parent_tag_id = NEW.id
        UNION ALL
        SELECT tag.id, descendants.depth + 1
          FROM tags AS tag
          INNER JOIN descendants ON tag.parent_tag_id = descendants.id
         WHERE descendants.depth < 32
    )
    SELECT COALESCE(max(descendants.depth), 0) + 1
      INTO subtree_height
      FROM descendants;

    IF parent_depth + subtree_height > 5 THEN
        RAISE EXCEPTION 'tag hierarchy cannot exceed five levels'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_hierarchy_max_depth';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tags_validate_hierarchy
BEFORE INSERT OR UPDATE OF parent_tag_id, approval_status, archived_at ON tags
FOR EACH ROW
EXECUTE FUNCTION validate_tag_hierarchy();

CREATE OR REPLACE FUNCTION validate_tag_merge()
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
        hashtextextended('knowledge-tag-hierarchy', 0)
    );
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

    IF EXISTS (
        SELECT 1
          FROM tags AS child
         WHERE child.parent_tag_id = NEW.source_tag_id
    ) THEN
        RAISE EXCEPTION 'a tag with child tags cannot be a merge source'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_merges_source_without_children';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM tags AS source
         WHERE source.id = NEW.source_tag_id
           AND source.parent_tag_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'a merge source must leave the tag hierarchy first'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_merges_source_must_leave_hierarchy';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

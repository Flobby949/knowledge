BEGIN;

ALTER TABLE knowledge_points
    ADD CONSTRAINT knowledge_points_id_analysis_unique
    UNIQUE (id, analysis_revision_id);

ALTER TABLE tag_assignments
    ADD COLUMN analysis_revision_id uuid,
    ADD COLUMN raw_label text;

-- The former schema did not retain historical model spelling, so use the
-- current Tag display name as the only recoverable fallback for existing rows.
UPDATE tag_assignments AS assignment
   SET analysis_revision_id = point.analysis_revision_id,
       raw_label = tag.display_name
  FROM knowledge_points AS point,
       tags AS tag
 WHERE assignment.assigned_by = 'AI'
   AND point.id = assignment.knowledge_point_id
   AND tag.id = assignment.tag_id;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE tag_assignments
    ADD CONSTRAINT tag_assignments_point_analysis_fk
    FOREIGN KEY (knowledge_point_id, analysis_revision_id)
    REFERENCES knowledge_points (id, analysis_revision_id) ON DELETE CASCADE,
    ADD CONSTRAINT tag_assignments_provenance_check CHECK (
        (assigned_by = 'USER'
            AND analysis_revision_id IS NULL
            AND raw_label IS NULL)
        OR (assigned_by = 'AI'
            AND analysis_revision_id IS NOT NULL
            AND raw_label IS NOT NULL
            AND raw_label <> '')
    );

COMMIT;

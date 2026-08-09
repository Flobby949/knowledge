BEGIN;

CREATE TABLE knowledge_point_corrections (
    knowledge_point_id uuid PRIMARY KEY
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    title text NOT NULL,
    body text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_point_corrections_title_check CHECK (title <> ''),
    CONSTRAINT knowledge_point_corrections_body_check CHECK (body <> '')
);

COMMIT;

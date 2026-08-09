BEGIN;

CREATE TABLE record_overview_corrections (
    record_id uuid PRIMARY KEY
        REFERENCES records (id) ON DELETE CASCADE,
    analysis_revision_id uuid NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT record_overview_corrections_analysis_fk
        FOREIGN KEY (record_id, analysis_revision_id)
        REFERENCES ai_analysis_revisions (record_id, id) ON DELETE CASCADE,
    CONSTRAINT record_overview_corrections_title_check CHECK (title <> ''),
    CONSTRAINT record_overview_corrections_summary_check CHECK (summary <> '')
);

COMMIT;

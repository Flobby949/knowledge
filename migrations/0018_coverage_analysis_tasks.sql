BEGIN;

ALTER TABLE coverage_analyses
    ALTER COLUMN framework_summary DROP NOT NULL,
    ALTER COLUMN caveat DROP NOT NULL,
    ADD COLUMN input_kind text NOT NULL DEFAULT 'KNOWLEDGE_POINTS',
    ADD COLUMN status text NOT NULL DEFAULT 'SUCCEEDED',
    ADD COLUMN failure_code text,
    ADD COLUMN failure_message text,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 1,
    ADD COLUMN started_at timestamptz,
    ADD COLUMN completed_at timestamptz;

UPDATE coverage_analyses
   SET started_at = created_at,
       completed_at = created_at;

ALTER TABLE coverage_analyses
    ADD CONSTRAINT coverage_analyses_input_kind_check
        CHECK (input_kind IN ('KNOWLEDGE_POINTS', 'RECORDS')),
    ADD CONSTRAINT coverage_analyses_status_check
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    ADD CONSTRAINT coverage_analyses_attempt_count_check
        CHECK (attempt_count >= 1),
    ADD CONSTRAINT coverage_analyses_failure_pair_check
        CHECK ((failure_code IS NULL) = (failure_message IS NULL)),
    ADD CONSTRAINT coverage_analyses_lifecycle_check
        CHECK (
            (status = 'QUEUED'
                AND framework_summary IS NULL
                AND caveat IS NULL
                AND failure_code IS NULL
                AND started_at IS NULL
                AND completed_at IS NULL)
            OR (status = 'RUNNING'
                AND framework_summary IS NULL
                AND caveat IS NULL
                AND failure_code IS NULL
                AND started_at IS NOT NULL
                AND completed_at IS NULL)
            OR (status = 'SUCCEEDED'
                AND framework_summary IS NOT NULL
                AND caveat IS NOT NULL
                AND failure_code IS NULL
                AND started_at IS NOT NULL
                AND completed_at IS NOT NULL)
            OR (status = 'FAILED'
                AND framework_summary IS NULL
                AND caveat IS NULL
                AND failure_code IS NOT NULL
                AND completed_at IS NOT NULL)
        );

CREATE TABLE coverage_analysis_records (
    analysis_id uuid NOT NULL
        REFERENCES coverage_analyses (id) ON DELETE CASCADE,
    record_id uuid NOT NULL
        REFERENCES records (id) ON DELETE CASCADE,
    fragment_revision_id uuid NOT NULL
        REFERENCES fragment_revisions (id) ON DELETE RESTRICT,
    title text NOT NULL,
    content_fingerprint text NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (analysis_id, record_id),
    CONSTRAINT coverage_analysis_records_title_check CHECK (title <> ''),
    CONSTRAINT coverage_analysis_records_fingerprint_check
        CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT coverage_analysis_records_position_check CHECK (position >= 1),
    CONSTRAINT coverage_analysis_records_position_unique
        UNIQUE (analysis_id, position)
);

CREATE FUNCTION validate_coverage_analysis_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM fragment_revisions AS revision
         WHERE revision.id = NEW.fragment_revision_id
           AND revision.record_id = NEW.record_id
    ) THEN
        RAISE EXCEPTION 'coverage record revision must belong to the record'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'coverage_analysis_records_revision_record';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_analysis_records_validate
BEFORE INSERT OR UPDATE ON coverage_analysis_records
FOR EACH ROW
EXECUTE FUNCTION validate_coverage_analysis_record();

CREATE TABLE coverage_item_records (
    item_id uuid NOT NULL
        REFERENCES coverage_analysis_items (id) ON DELETE CASCADE,
    record_id uuid NOT NULL
        REFERENCES records (id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, record_id)
);

CREATE FUNCTION validate_coverage_item_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_analysis_id uuid;
BEGIN
    SELECT item.analysis_id
      INTO target_analysis_id
      FROM coverage_analysis_items AS item
     WHERE item.id = NEW.item_id;

    IF target_analysis_id IS NULL OR NOT EXISTS (
        SELECT 1
          FROM coverage_analysis_records AS input
         WHERE input.analysis_id = target_analysis_id
           AND input.record_id = NEW.record_id
    ) THEN
        RAISE EXCEPTION 'coverage evidence must belong to the analysis input'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'coverage_item_records_analysis_input';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_item_records_validate
BEFORE INSERT OR UPDATE ON coverage_item_records
FOR EACH ROW
EXECUTE FUNCTION validate_coverage_item_record();

CREATE INDEX coverage_analyses_status_idx
    ON coverage_analyses (status, created_at DESC);

COMMIT;

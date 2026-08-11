BEGIN;

CREATE TYPE coverage_item_kind AS ENUM ('COVERED', 'POSSIBLE_GAP');

CREATE TABLE coverage_analyses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic text NOT NULL,
    framework_summary text NOT NULL,
    caveat text NOT NULL,
    input_count smallint NOT NULL,
    model_configuration_version integer NOT NULL,
    text_model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coverage_analyses_topic_check CHECK (topic <> ''),
    CONSTRAINT coverage_analyses_framework_check CHECK (framework_summary <> ''),
    CONSTRAINT coverage_analyses_caveat_check CHECK (caveat <> ''),
    CONSTRAINT coverage_analyses_input_count_check
        CHECK (input_count BETWEEN 1 AND 50),
    CONSTRAINT coverage_analyses_model_check CHECK (
        model_configuration_version > 0
        AND text_model <> ''
    )
);

CREATE TABLE coverage_analysis_points (
    analysis_id uuid NOT NULL
        REFERENCES coverage_analyses (id) ON DELETE CASCADE,
    knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    content_fingerprint text NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (analysis_id, knowledge_point_id),
    CONSTRAINT coverage_analysis_points_fingerprint_check
        CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT coverage_analysis_points_position_check CHECK (position >= 1),
    CONSTRAINT coverage_analysis_points_position_unique
        UNIQUE (analysis_id, position)
);

CREATE TABLE coverage_analysis_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id uuid NOT NULL
        REFERENCES coverage_analyses (id) ON DELETE CASCADE,
    kind coverage_item_kind NOT NULL,
    position integer NOT NULL,
    title text NOT NULL,
    assessment text NOT NULL,
    recommendation text,
    CONSTRAINT coverage_analysis_items_position_check CHECK (position >= 1),
    CONSTRAINT coverage_analysis_items_text_check CHECK (
        title <> ''
        AND assessment <> ''
    ),
    CONSTRAINT coverage_analysis_items_recommendation_check CHECK (
        (kind = 'COVERED' AND recommendation IS NULL)
        OR (kind = 'POSSIBLE_GAP'
            AND recommendation IS NOT NULL
            AND recommendation <> '')
    ),
    CONSTRAINT coverage_analysis_items_position_unique
        UNIQUE (analysis_id, position)
);

CREATE TABLE coverage_item_points (
    item_id uuid NOT NULL
        REFERENCES coverage_analysis_items (id) ON DELETE CASCADE,
    knowledge_point_id uuid NOT NULL
        REFERENCES knowledge_points (id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, knowledge_point_id)
);

CREATE FUNCTION validate_coverage_item_point()
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
          FROM coverage_analysis_points AS input
         WHERE input.analysis_id = target_analysis_id
           AND input.knowledge_point_id = NEW.knowledge_point_id
    ) THEN
        RAISE EXCEPTION 'coverage evidence must belong to the analysis input'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'coverage_item_points_analysis_input';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_item_points_validate
BEFORE INSERT OR UPDATE ON coverage_item_points
FOR EACH ROW
EXECUTE FUNCTION validate_coverage_item_point();

CREATE INDEX coverage_analyses_created_idx
    ON coverage_analyses (created_at DESC, id DESC);

COMMIT;

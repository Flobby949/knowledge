BEGIN;

CREATE TYPE semantic_source_type AS ENUM ('ORIGINAL', 'KNOWLEDGE_POINT');

CREATE TABLE semantic_embeddings (
    configuration_version integer NOT NULL
        REFERENCES model_configurations (version) ON DELETE CASCADE,
    embedding_model text NOT NULL,
    source_type semantic_source_type NOT NULL,
    source_id uuid NOT NULL,
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    text_content text NOT NULL,
    embedding double precision[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (configuration_version, source_type, source_id),
    CONSTRAINT semantic_embeddings_text_check CHECK (text_content <> ''),
    CONSTRAINT semantic_embeddings_vector_check CHECK (cardinality(embedding) > 0)
);

CREATE INDEX semantic_embeddings_active_record_idx
    ON semantic_embeddings (configuration_version, record_id);

COMMIT;

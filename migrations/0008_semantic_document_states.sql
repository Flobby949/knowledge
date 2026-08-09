BEGIN;

CREATE TYPE semantic_document_status AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE semantic_document_states (
    configuration_version integer NOT NULL
        REFERENCES model_configurations (version) ON DELETE CASCADE,
    source_type semantic_source_type NOT NULL,
    source_id uuid NOT NULL,
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    text_content text NOT NULL,
    status semantic_document_status NOT NULL,
    failure_reason text,
    attempt_count integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (configuration_version, source_type, source_id),
    CONSTRAINT semantic_document_states_text_check CHECK (text_content <> ''),
    CONSTRAINT semantic_document_states_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT semantic_document_states_failure_check CHECK (
        (status = 'FAILED' AND failure_reason IS NOT NULL)
        OR (status <> 'FAILED' AND failure_reason IS NULL)
    )
);

CREATE INDEX semantic_document_states_health_idx
    ON semantic_document_states (configuration_version, status);

CREATE TABLE semantic_index_states (
    configuration_version integer PRIMARY KEY
        REFERENCES model_configurations (version) ON DELETE CASCADE,
    activated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

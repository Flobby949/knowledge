BEGIN;

CREATE TYPE model_config_state AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');

CREATE TABLE model_configurations (
    version integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state model_config_state NOT NULL,
    text_base_url text NOT NULL,
    text_model text NOT NULL,
    text_credential_ciphertext text NOT NULL,
    text_test_fingerprint text,
    embedding_base_url text NOT NULL,
    embedding_model text NOT NULL,
    embedding_credential_ciphertext text NOT NULL,
    embedding_test_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    CONSTRAINT model_config_text_base_url_check CHECK (text_base_url <> ''),
    CONSTRAINT model_config_text_model_check CHECK (text_model <> ''),
    CONSTRAINT model_config_embedding_base_url_check CHECK (embedding_base_url <> ''),
    CONSTRAINT model_config_embedding_model_check CHECK (embedding_model <> ''),
    CONSTRAINT model_config_activation_time_check CHECK (
        (state = 'ACTIVE' AND activated_at IS NOT NULL)
        OR (state <> 'ACTIVE')
    )
);

CREATE UNIQUE INDEX model_config_one_draft_idx
    ON model_configurations ((state))
    WHERE state = 'DRAFT';

CREATE UNIQUE INDEX model_config_one_active_idx
    ON model_configurations ((state))
    WHERE state = 'ACTIVE';

COMMIT;

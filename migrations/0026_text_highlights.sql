BEGIN;

CREATE TABLE text_highlights (
    record_id uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    target text NOT NULL,
    content text NOT NULL,
    highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    PRIMARY KEY (record_id, target),
    CHECK (target ~ '^source:[1-9][0-9]*$' OR target ~ '^knowledge:[0-9a-f-]{36}$'),
    CHECK (jsonb_typeof(highlights) = 'array')
);

COMMIT;

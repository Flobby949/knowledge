BEGIN;

CREATE TABLE instance_preferences (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    default_ai_handling text NOT NULL DEFAULT 'AUTOMATIC'
        CHECK (default_ai_handling IN ('AUTOMATIC', 'REVIEW')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO instance_preferences (singleton) VALUES (true);

COMMIT;

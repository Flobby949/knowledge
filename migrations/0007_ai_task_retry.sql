BEGIN;

ALTER TABLE ai_tasks
    ADD COLUMN retry_of_task_id uuid
        REFERENCES ai_tasks (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX ai_tasks_one_retry_per_task_idx
    ON ai_tasks (retry_of_task_id)
    WHERE retry_of_task_id IS NOT NULL;

COMMIT;

BEGIN;

ALTER TABLE instance_preferences
    ADD COLUMN analysis_prompt text NOT NULL DEFAULT
        $analysis_prompt$你是中文知识整理器。只返回 JSON。生成简洁中文标题、摘要和 1–5 个自包含知识点。每个知识点必须给出原文中从 0 开始、按 UTF-16 code unit 计数的 start（含）和 end（不含），并给出与该区间完全一致的 quote。知识点仅陈述原文支持的事实。$analysis_prompt$,
    ADD CONSTRAINT instance_preferences_analysis_prompt_check
        CHECK (btrim(analysis_prompt) <> '');

ALTER TABLE ai_tasks
    ADD COLUMN analysis_prompt text NOT NULL DEFAULT
        $analysis_prompt$你是中文知识整理器。只返回 JSON。生成简洁中文标题、摘要和 1–5 个自包含知识点。每个知识点必须给出原文中从 0 开始、按 UTF-16 code unit 计数的 start（含）和 end（不含），并给出与该区间完全一致的 quote。知识点仅陈述原文支持的事实。$analysis_prompt$,
    ADD CONSTRAINT ai_tasks_analysis_prompt_check
        CHECK (btrim(analysis_prompt) <> '');

ALTER TABLE ai_tasks ALTER COLUMN analysis_prompt DROP DEFAULT;

COMMIT;

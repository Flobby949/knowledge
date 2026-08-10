export const DEFAULT_ANALYSIS_PROMPT =
  "你是中文知识整理器。只返回 JSON。生成简洁中文标题、摘要和 1–5 个自包含知识点。" +
  "每个知识点必须给出原文中从 0 开始、按 UTF-16 code unit 计数的 start（含）和 end（不含），并给出与该区间完全一致的 quote。" +
  "知识点仅陈述原文支持的事实。";

export const FIXED_ANALYSIS_OUTPUT_SCHEMA_PROMPT =
  "JSON 结构：{title,summary,knowledgePoints:[{title,body,candidateTags,evidenceSpans:[{quote,start,end}]}]}。";

export function composeAnalysisSystemPrompt(
  analysisPrompt = DEFAULT_ANALYSIS_PROMPT,
): string {
  return `${analysisPrompt.trim()}${FIXED_ANALYSIS_OUTPUT_SCHEMA_PROMPT}`;
}

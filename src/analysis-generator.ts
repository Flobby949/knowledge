import { countGraphemes } from "./domain/fragment-text.js";

export interface GeneratedEvidenceSpan {
  quote: string;
  start: number;
  end: number;
}

export interface GeneratedKnowledgePoint {
  title: string;
  body: string;
  candidateTags: string[];
  evidenceSpans: GeneratedEvidenceSpan[];
}

export interface GeneratedAnalysis {
  title: string;
  summary: string;
  knowledgePoints: GeneratedKnowledgePoint[];
}

export interface GenerateAnalysisInput {
  sourceText: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
}

export type AnalysisGenerator = (
  input: GenerateAnalysisInput,
) => Promise<GeneratedAnalysis>;

export function analysisRequestTimeoutMs(sourceText: string): number {
  const graphemeCount = countGraphemes(sourceText);

  if (graphemeCount <= 250) {
    return 120_000;
  }

  if (graphemeCount <= 500) {
    return 240_000;
  }

  if (graphemeCount <= 750) {
    return 420_000;
  }

  return 600_000;
}

export const generateOpenAICompatibleAnalysis: AnalysisGenerator = async (
  input,
) => {
  const response = await fetch(
    new URL("chat/completions", ensureTrailingSlash(input.baseUrl)),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "system",
            content:
              "你是中文知识整理器。只返回 JSON。生成简洁中文标题、摘要和 1–5 个自包含知识点。" +
              "每个知识点必须给出原文 UTF-16 的 start/end 与完全一致的 quote，并仅陈述原文支持的事实。" +
              "JSON 结构：{title,summary,knowledgePoints:[{title,body,candidateTags,evidenceSpans:[{quote,start,end}]}]}。",
          },
          { role: "user", content: input.sourceText },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(analysisRequestTimeoutMs(input.sourceText)),
    },
  );

  if (!response.ok) {
    throw new Error(`Analysis request failed with status ${response.status}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Analysis response did not contain message content");
  }

  return JSON.parse(stripCodeFence(content)) as GeneratedAnalysis;
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);

  return match?.[1] ?? trimmed;
}

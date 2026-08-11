export interface CoveragePointInput {
  body: string;
  id: string;
  title: string;
}

export interface GenerateCoverageInput {
  apiKey: string;
  baseUrl: string;
  configurationVersion: number;
  knowledgePoints: CoveragePointInput[];
  model: string;
  topic: string;
}

export interface GeneratedCoverageAnalysis {
  caveat: string;
  covered: Array<{
    assessment: string;
    knowledgePointIds: string[];
    title: string;
  }>;
  frameworkSummary: string;
  possibleGaps: Array<{
    assessment: string;
    recommendation: string;
    title: string;
  }>;
}

export type CoverageGenerator = (
  input: GenerateCoverageInput,
) => Promise<GeneratedCoverageAnalysis>;

const COVERAGE_SYSTEM_PROMPT = `你负责基于用户明确选择的知识点，提供一次实验性的主题覆盖分析。

规则：
- 只把输入知识点能够支持的内容列为“已有覆盖”；每项必须引用真实 knowledgePointIds。
- “可能缺口”来自你提出的参考框架，只能写成建议或值得探索的方向，不能写成用户客观缺失的事实。
- 不创建 Ontology、Concept，不给用户打分，不补写输入中不存在的事实。
- 使用中文自然语言，技术专名保留常用原写法。

返回 JSON：
{
  "frameworkSummary": "本次采用的参考框架",
  "covered": [{"title":"...","assessment":"...","knowledgePointIds":["..."]}],
  "possibleGaps": [{"title":"...","assessment":"为什么可能值得补充","recommendation":"建议的下一步"}],
  "caveat": "明确说明这是基于所选知识与模型参考框架的建议，不是客观完备度结论"
}

covered 与 possibleGaps 各最多 12 项，合计至少一项。不要返回 Markdown。`;

export const generateOpenAICompatibleCoverage: CoverageGenerator = async (
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
          { role: "system", content: COVERAGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              topic: input.topic,
              knowledgePoints: input.knowledgePoints,
            }),
          },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Coverage request failed with status ${response.status}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Coverage response did not contain message content");
  }

  return JSON.parse(stripCodeFence(content)) as GeneratedCoverageAnalysis;
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);

  return match?.[1] ?? trimmed;
}

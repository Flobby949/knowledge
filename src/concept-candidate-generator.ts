import { countGraphemes } from "./domain/fragment-text.js";

export interface ConceptCandidatePointInput {
  body: string;
  evidence: Array<{
    endOffset: number;
    id: string;
    quote: string;
    startOffset: number;
  }>;
  id: string;
  title: string;
}

export interface GenerateConceptCandidateInput {
  apiKey: string;
  baseUrl: string;
  configurationVersion: number;
  model: string;
  points: ConceptCandidatePointInput[];
  timeoutMs?: number;
}

export type GeneratedConceptCandidate =
  | { candidate: null; reason: string }
  | {
      candidate: {
        description: string;
        knowledgePointIds: string[];
        name: string;
        reason: string;
      };
    };

export type ConceptCandidateGenerator = (
  input: GenerateConceptCandidateInput,
) => Promise<GeneratedConceptCandidate>;

export function conceptCandidateTimeoutMs(
  points: ConceptCandidatePointInput[],
): number {
  const graphemeCount = countGraphemes(
    points
      .flatMap((point) => [
        point.title,
        point.body,
        ...point.evidence.map(({ quote }) => quote),
      ])
      .join("\n"),
  );

  if (graphemeCount <= 2_000) {
    return 300_000;
  }

  if (graphemeCount <= 4_000) {
    return 420_000;
  }

  if (graphemeCount <= 8_000) {
    return 540_000;
  }

  return 600_000;
}

const CONCEPT_CANDIDATE_SYSTEM_PROMPT = `你负责基于用户明确选择的多个当前知识点，判断它们是否值得形成一个长期 Concept Candidate。

规则：
- 只能使用输入知识点及其证据支持的内容，不补充外部事实。
- 如果不存在至少两个知识点共同支撑的自足概念，返回 candidate: null 和明确理由。
- 如果存在，只提出一个最有复用价值的候选。
- name 是简洁、稳定的中文概念名；description 是脱离本次输入仍可独立理解的定义。
- reason 解释为什么这些知识点应被聚合，但不能把模型判断写成客观事实。
- knowledgePointIds 至少两个、不得重复，且只能引用输入中的真实 id。
- 这只是待人工确认的建议，不得声称已经创建正式 Concept。

返回 JSON，二选一：
{"candidate":null,"reason":"为什么不建议形成 Concept"}
{"candidate":{"name":"...","description":"...","reason":"...","knowledgePointIds":["..."]}}

不要返回 Markdown。`;

export const generateOpenAICompatibleConceptCandidate: ConceptCandidateGenerator =
  async (input) => {
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
            { role: "system", content: CONCEPT_CANDIDATE_SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({ points: input.points }),
            },
          ],
          response_format: { type: "json_object" },
          stream: false,
        }),
        signal: AbortSignal.timeout(
          input.timeoutMs ?? conceptCandidateTimeoutMs(input.points),
        ),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Concept Candidate request failed with status ${response.status}`,
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Concept Candidate response did not contain content");
    }

    return JSON.parse(stripCodeFence(content)) as GeneratedConceptCandidate;
  };

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);

  return match?.[1] ?? trimmed;
}

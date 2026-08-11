import { countGraphemes } from "./domain/fragment-text.js";

export type GeneratedRelationType =
  | "analogy"
  | "applies"
  | "contrasts"
  | "extends"
  | "prerequisite"
  | "similar";

export interface RelationPointInput {
  body: string;
  evidence: Array<{ id: string; quote: string }>;
  id: string;
  title: string;
}

export interface GenerateRelationInput {
  apiKey: string;
  baseUrl: string;
  configurationVersion: number;
  model: string;
  pointA: RelationPointInput;
  pointB: RelationPointInput;
  timeoutMs?: number;
}

export type GeneratedRelation =
  | { related: false }
  | {
      confidence: number;
      description: string;
      direction: "a_to_b" | "b_to_a";
      evidenceAIds: string[];
      evidenceBIds: string[];
      reason: string;
      related: true;
      type: GeneratedRelationType;
    };

export type RelationGenerator = (
  input: GenerateRelationInput,
) => Promise<GeneratedRelation>;

export function relationRequestTimeoutMs(
  input: Pick<GenerateRelationInput, "pointA" | "pointB">,
): number {
  const graphemeCount = countGraphemes(
    [
      input.pointA.title,
      input.pointA.body,
      ...input.pointA.evidence.map(({ quote }) => quote),
      input.pointB.title,
      input.pointB.body,
      ...input.pointB.evidence.map(({ quote }) => quote),
    ].join("\n"),
  );

  if (graphemeCount <= 500) {
    return 300_000;
  }

  if (graphemeCount <= 1_000) {
    return 420_000;
  }

  if (graphemeCount <= 1_500) {
    return 540_000;
  }

  return 600_000;
}

const RELATION_SYSTEM_PROMPT = `你负责审查两个已有知识点之间是否存在高价值关系。只能依据给定知识点和证据，不补充外部事实。

如果没有明确、可复用的关系，返回 {"related":false}。
如果有关，返回一个 JSON 对象：
- related: true
- type: similar | contrasts | prerequisite | extends | applies | analogy
- direction: a_to_b | b_to_a；相似、对比、思想类比也保留该字段
- description: 简洁中文关系描述
- reason: 解释为什么形成该关系，且不得把置信度写成事实
- confidence: 0 到 1
- evidenceAIds / evidenceBIds: 各至少选择一个输入中真实存在的证据 id

不要返回 Markdown，不要创建 Concept，不要把相似度本身当作关系。`;

export const generateOpenAICompatibleRelation: RelationGenerator = async (
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
          { role: "system", content: RELATION_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              pointA: input.pointA,
              pointB: input.pointB,
            }),
          },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(
        input.timeoutMs ?? relationRequestTimeoutMs(input),
      ),
    },
  );

  if (!response.ok) {
    throw new Error(`Relation request failed with status ${response.status}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Relation response did not contain message content");
  }

  return JSON.parse(stripCodeFence(content)) as GeneratedRelation;
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);

  return match?.[1] ?? trimmed;
}

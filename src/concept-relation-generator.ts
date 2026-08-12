import { countGraphemes } from "./domain/fragment-text.js";

export type GeneratedConceptRelationType =
  | "analogy"
  | "applies"
  | "contrasts"
  | "extends"
  | "prerequisite"
  | "similar";

export interface ConceptRelationInput {
  description: string;
  id: string;
  memberCount: number;
  name: string;
}

export interface GenerateConceptRelationInput {
  apiKey: string;
  baseUrl: string;
  conceptA: ConceptRelationInput;
  conceptB: ConceptRelationInput;
  configurationVersion: number;
  model: string;
  timeoutMs?: number;
}

export type GeneratedConceptRelation =
  | { related: false }
  | {
      confidence: number;
      description: string;
      direction: "a_to_b" | "b_to_a";
      reason: string;
      related: true;
      type: GeneratedConceptRelationType;
    };

export type ConceptRelationGenerator = (
  input: GenerateConceptRelationInput,
) => Promise<GeneratedConceptRelation>;

export function conceptRelationRequestTimeoutMs(
  input: Pick<GenerateConceptRelationInput, "conceptA" | "conceptB">,
): number {
  const graphemeCount = countGraphemes(
    [
      input.conceptA.name,
      input.conceptA.description,
      input.conceptB.name,
      input.conceptB.description,
    ].join("\n"),
  );

  if (graphemeCount <= 500) {
    return 300_000;
  }

  if (graphemeCount <= 1_000) {
    return 420_000;
  }

  return 600_000;
}

const CONCEPT_RELATION_SYSTEM_PROMPT = `你负责判断两个正式 Concept 之间是否存在高价值关系。只能依据给定名称、定义和成员数量，不补充外部事实，也不能创建或修改 Concept。

如果没有明确、可复用的关系，返回 {"related":false}。
如果有关，返回一个 JSON 对象：
- related: true
- type: similar | contrasts | prerequisite | extends | applies | analogy
- direction: a_to_b | b_to_a；相似、对比、思想类比也保留该字段
- description: 简洁中文关系描述
- reason: 解释为什么形成该关系，且不得把置信度写成事实
- confidence: 0 到 1

不要返回 Markdown。related=true 会由系统自动建立为正式 Concept Relation，因此不确定时必须返回 related=false。`;

export const generateOpenAICompatibleConceptRelation: ConceptRelationGenerator =
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
            { role: "system", content: CONCEPT_RELATION_SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                conceptA: input.conceptA,
                conceptB: input.conceptB,
              }),
            },
          ],
          response_format: { type: "json_object" },
          stream: false,
        }),
        signal: AbortSignal.timeout(
          input.timeoutMs ?? conceptRelationRequestTimeoutMs(input),
        ),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Concept relation request failed with status ${response.status}`,
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(
        "Concept relation response did not contain message content",
      );
    }

    return JSON.parse(stripCodeFence(content)) as GeneratedConceptRelation;
  };

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);

  return match?.[1] ?? trimmed;
}

import { buildApp } from "./app.js";
import type { AnalysisGenerator } from "./analysis-generator.js";
import type { ConceptCandidateGenerator } from "./concept-candidate-generator.js";
import type { EmbedText } from "./embedding-provider.js";
import type { ModelEndpointTester } from "./model-endpoint-tester.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://knowledge:knowledge_dev@127.0.0.1:5432/knowledge";
const host = process.env.SERVER_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.SERVER_PORT ?? "3001", 10);
const textApiKey = process.env.DEEPSEEK_API_KEY;
const embeddingApiKey = process.env.KNOELEDGE_API_KEY;
const useE2eFakeAi = process.env.E2E_FAKE_AI === "1";
const reanalysisFakeCallsBySource = new Map<string, number>();
const taskRetryFakeCallsBySource = new Map<string, number>();
const e2eAiGates = new Map<string, E2eAiGate>();
const settledE2eAiTaskIds = new Set<string>();
const bootstrapModelDraft =
  !useE2eFakeAi && textApiKey && embeddingApiKey
    ? {
        text: {
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-flash",
          apiKey: textApiKey,
        },
        embedding: {
          baseUrl: "https://api.siliconflow.cn/v1",
          model: "BAAI/bge-m3",
          apiKey: embeddingApiKey,
        },
      }
    : undefined;
const app = await buildApp({
  databaseUrl,
  logger: true,
  ...(bootstrapModelDraft ? { bootstrapModelDraft } : {}),
  ...(useE2eFakeAi
    ? {
        generateAnalysis: generateE2eAnalysis,
        generateConceptCandidate: generateE2eConceptCandidate,
        embedText: embedE2eText,
        onAiTaskSettled: (taskId: string) => {
          settledE2eAiTaskIds.add(taskId);
        },
        testModelEndpoint: testE2eModelEndpoint,
      }
    : {}),
});

if (useE2eFakeAi) {
  app.get<{ Params: { gateId: string } }>(
    "/api/v1/e2e/ai-gates/:gateId",
    async (request) => {
      const gate = e2eAiGate(request.params.gateId);

      return { released: gate.released, started: gate.started };
    },
  );
  app.post<{ Params: { gateId: string } }>(
    "/api/v1/e2e/ai-gates/:gateId/release",
    async (request, reply) => {
      const gate = e2eAiGate(request.params.gateId);

      gate.released = true;
      gate.release();

      return reply.code(204).send();
    },
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/v1/e2e/ai-tasks/:taskId/settled",
    async (request) => ({
      settled: settledE2eAiTaskIds.has(request.params.taskId),
    }),
  );
}

await app.listen({ host, port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

async function testE2eModelEndpoint(): ReturnType<ModelEndpointTester> {
  return { status: "passed" };
}

async function embedE2eText(
  input: Parameters<EmbedText>[0],
): ReturnType<EmbedText> {
  const marker = /\/concept-([0-9a-f]{8})\//u.exec(input.baseUrl)?.[1];

  if (!marker) {
    throw new Error("E2E embedding is only available to Concept scenarios");
  }

  return input.text.includes(marker) ? [1, 0, 0] : [0, 1, 0];
}

async function generateE2eConceptCandidate({
  points,
}: Parameters<ConceptCandidateGenerator>[0]): ReturnType<ConceptCandidateGenerator> {
  await new Promise<void>((resolve) => setTimeout(resolve, 120));

  return {
    candidate: {
      name: `共同机制：${points[0]?.title ?? "知识点组合"}`,
      description: "这些知识点共同描述一个可复用的机制，需要人工确认定义与最终成员。",
      reason: "所选知识点共享同一工作机制，适合形成一个可维护的 Concept 候选。",
      knowledgePointIds: points
        .slice(0, Math.max(2, Math.min(3, points.length)))
        .map((point) => point.id),
    },
  };
}

async function generateE2eAnalysis({
  sourceText,
}: Parameters<AnalysisGenerator>[0]): ReturnType<AnalysisGenerator> {
  const taskRetryGateId = aiTaskRetryGateId(sourceText);
  const gateId = deleteDuringAiGateId(sourceText);

  if (taskRetryGateId) {
    const call = (taskRetryFakeCallsBySource.get(sourceText) ?? 0) + 1;

    taskRetryFakeCallsBySource.set(sourceText, call);

    if (call === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      throw new Error("E2E 模拟 AI 服务暂时不可用");
    }

    const gate = e2eAiGate(taskRetryGateId);

    gate.started = true;
    await gate.wait;
  } else if (gateId) {
    const gate = e2eAiGate(gateId);

    gate.started = true;
    await gate.wait;
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  }
  const separator = sourceText.indexOf("\n");
  const firstQuote = separator === -1 ? sourceText : sourceText.slice(0, separator);
  const secondStart = separator === -1 ? sourceText.length : separator + 1;
  const secondQuote = sourceText.slice(secondStart);

  if (sourceText.includes("E2E_REANALYSIS_COMPARISON ")) {
    const call = (reanalysisFakeCallsBySource.get(sourceText) ?? 0) + 1;
    reanalysisFakeCallsBySource.set(sourceText, call);

    return reanalysisComparisonOutput({
      call,
      firstQuote,
      secondQuote,
      secondStart,
    });
  }

  const tagAtlasMarker = /E2E_TAG_ATLAS ([0-9a-f]{8})/u.exec(sourceText)?.[1];

  if (tagAtlasMarker) {
    const sharedCandidate = `图鉴共享候选 ${tagAtlasMarker}`;

    return {
      title: `标签图鉴候选 ${tagAtlasMarker}`,
      summary: "用于验证候选标签按记录聚合和逐条管理的确定性结果。",
      knowledgePoints: [
        {
          title: `共享候选来源一 ${tagAtlasMarker}`,
          body: firstQuote,
          candidateTags: [
            sharedCandidate,
            `图鉴可删除候选 ${tagAtlasMarker}`,
          ],
          evidenceSpans: [
            { quote: firstQuote, start: 0, end: firstQuote.length },
          ],
        },
        {
          title: `共享候选来源二 ${tagAtlasMarker}`,
          body: secondQuote,
          candidateTags: [sharedCandidate],
          evidenceSpans: [
            {
              quote: secondQuote,
              start: secondStart,
              end: secondStart + secondQuote.length,
            },
          ],
        },
      ],
    };
  }

  return {
    title: "CDC 与事务日志",
    summary: "数据库变更捕获与事务日志的整理结果。",
    knowledgePoints: [
      {
        title: "CDC 如何获取数据库变更",
        body: firstQuote,
        candidateTags: ["CDC", "事务日志"],
        evidenceSpans: [
          { quote: firstQuote, start: 0, end: firstQuote.length },
        ],
      },
      {
        title: "事务日志保留哪些信息",
        body: secondQuote,
        candidateTags: ["事务日志", "增量变更"],
        evidenceSpans: [
          {
            quote: secondQuote,
            start: secondStart,
            end: secondStart + secondQuote.length,
          },
        ],
      },
    ],
  };
}

interface E2eAiGate {
  release: () => void;
  released: boolean;
  started: boolean;
  wait: Promise<void>;
}

function deleteDuringAiGateId(sourceText: string): string | null {
  return /E2E_DELETE_DURING_AI ([0-9a-f]{8})/u.exec(sourceText)?.[1] ?? null;
}

function aiTaskRetryGateId(sourceText: string): string | null {
  return /E2E_AI_TASK_RETRY ([0-9a-f]{8})/u.exec(sourceText)?.[1] ?? null;
}

function e2eAiGate(gateId: string): E2eAiGate {
  const existing = e2eAiGates.get(gateId);

  if (existing) {
    return existing;
  }

  let release: () => void = () => undefined;
  const gate: E2eAiGate = {
    release: () => release(),
    released: false,
    started: false,
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };

  e2eAiGates.set(gateId, gate);

  return gate;
}

function reanalysisComparisonOutput({
  call,
  firstQuote,
  secondQuote,
  secondStart,
}: {
  call: number;
  firstQuote: string;
  secondQuote: string;
  secondStart: number;
}): Awaited<ReturnType<AnalysisGenerator>> {
  const firstEvidence = [
    { quote: firstQuote, start: 0, end: firstQuote.length },
  ];
  const secondEvidence = [
    {
      quote: secondQuote,
      start: secondStart,
      end: secondStart + secondQuote.length,
    },
  ];

  if (call === 1) {
    return {
      title: "重新整理基线 V1",
      summary: "V1 当前摘要：保留数据库日志与提交顺序。",
      knowledgePoints: [
        {
          title: "当前：读取事务日志",
          body: firstQuote,
          candidateTags: ["基线日志"],
          evidenceSpans: firstEvidence,
        },
        {
          title: "当前：保留提交顺序",
          body: secondQuote,
          candidateTags: ["提交顺序"],
          evidenceSpans: secondEvidence,
        },
      ],
    };
  }

  if (call === 2) {
    return {
      title: "重新整理候选 V2",
      summary: "V2 候选摘要：补充增量边界并细分验证。",
      knowledgePoints: [
        {
          title: "候选 V2：读取事务日志",
          body: firstQuote,
          candidateTags: ["候选新增标签", "日志读取"],
          evidenceSpans: firstEvidence,
        },
        {
          title: "候选 V2：保留提交顺序",
          body: secondQuote,
          candidateTags: ["提交顺序"],
          evidenceSpans: secondEvidence,
        },
        {
          title: "候选 V2：验证增量边界",
          body: secondQuote,
          candidateTags: ["增量验证"],
          evidenceSpans: secondEvidence,
        },
      ],
    };
  }

  return {
    title: "应丢弃候选 V3",
    summary: "V3 候选摘要：尝试合并知识点。",
    knowledgePoints: [
      {
        title: "候选 V3：合并读取与顺序",
        body: firstQuote,
        candidateTags: ["合并候选"],
        evidenceSpans: firstEvidence,
      },
      {
        title: "候选 V3：边界检查",
        body: secondQuote,
        candidateTags: ["边界检查"],
        evidenceSpans: secondEvidence,
      },
    ],
  };
}

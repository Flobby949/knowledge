import { createHash } from "node:crypto";

import { expect, type APIRequestContext } from "@playwright/test";

import { createZip } from "../../src/zip-archive.js";

const FIXED_TIME = "2099-08-09T08:00:00.000Z";

export const visualFixture = {
  detailRecordId: stableUuid(1, 1),
  reviewRecordId: stableUuid(1, 2),
  focusedTagName: "变更捕获",
  primaryTagId: stableUuid(3, 1),
  primaryTagName: "数据库",
  searchQuery: "CDC",
} as const;

let fixtureReady = false;

export async function ensureVisualFixture(
  request: APIRequestContext,
  appBaseUrl: string,
): Promise<void> {
  if (fixtureReady) {
    return;
  }

  const archive = createVisualRestoreArchive();
  const inspected = await request.post(`${appBaseUrl}/api/v1/restores/inspect`, {
    data: archive,
    headers: { "content-type": "application/zip" },
  });

  expect(inspected.status()).toBe(200);
  const inspection = (await inspected.json()) as {
    inspection: { canRestore: boolean; id: string; recordCount: number };
  };

  expect(inspection.inspection).toMatchObject({
    canRestore: true,
    recordCount: 12,
  });

  const restored = await request.post(`${appBaseUrl}/api/v1/restores`, {
    data: { inspectionId: inspection.inspection.id },
  });

  expect(restored.status()).toBe(201);

  const concept = await request.post(`${appBaseUrl}/api/v1/concepts`, {
    data: {
      name: "变更数据捕获",
      description:
        "通过读取事务日志识别增量变化，并以有序事件向下游传播，避免周期轮询造成的负载与延迟。",
      knowledgePointIds: [stableUuid(6, 1), stableUuid(6, 2), stableUuid(6, 3)],
    },
  });

  expect(concept.status()).toBe(201);

  await configureDeterministicFakeModels(request, appBaseUrl);
  fixtureReady = true;
}

async function configureDeterministicFakeModels(
  request: APIRequestContext,
  appBaseUrl: string,
): Promise<void> {
  const draft = {
    text: {
      baseUrl: "http://127.0.0.1:9/e2e-text/v1",
      model: "deepseek-v4-flash",
      apiKey: "visual-fake-text-key",
    },
    embedding: {
      baseUrl: "http://127.0.0.1:9/e2e-embedding/v1",
      model: "BAAI/bge-m3",
      apiKey: "visual-fake-embedding-key",
    },
  };

  expect(
    (await request.put(`${appBaseUrl}/api/v1/model-config/draft`, { data: draft }))
      .status(),
  ).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    expect(
      (
        await request.post(
          `${appBaseUrl}/api/v1/model-config/draft/tests/${kind}`,
        )
      ).status(),
    ).toBe(200);
  }

  expect(
    (
      await request.post(
        `${appBaseUrl}/api/v1/model-config/draft/activate`,
      )
    ).status(),
  ).toBe(200);

  expect(
    (await request.put(`${appBaseUrl}/api/v1/model-config/draft`, { data: draft }))
      .status(),
  ).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    expect(
      (
        await request.post(
          `${appBaseUrl}/api/v1/model-config/draft/tests/${kind}`,
        )
      ).status(),
    ).toBe(200);
  }

  expect(
    (
      await request.patch(`${appBaseUrl}/api/v1/preferences`, {
        data: { defaultAiHandling: "review" },
      })
    ).status(),
  ).toBe(200);
}

function createVisualRestoreArchive(): Buffer {
  const userTags = [
    "数据库",
    "架构设计",
    "Redis",
    "Kafka",
    "DDD",
    "事件驱动",
    "数据同步",
    "Java",
    "一致性",
    "运维",
  ].map((name, index) => ({
    id: stableUuid(3, index + 1),
    display_name: name,
    normalized_name: /[A-Z]/u.test(name) ? name.toLocaleLowerCase() : name,
    origin: "USER_CREATED",
    approval_status: "USER_APPROVED",
    user_approved_at: FIXED_TIME,
    archived_at: null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  }));
  const candidateTag = {
    id: stableUuid(3, 11),
    display_name: visualFixture.focusedTagName,
    normalized_name: visualFixture.focusedTagName,
    origin: "AI_CREATED",
    approval_status: "CANDIDATE",
    user_approved_at: null,
    archived_at: null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
  const detailSource = [
    "CDC 通过读取数据库事务日志捕获增量变更，并以事件驱动方式实时推送。",
    "传统轮询会增加数据库负载，也带来延迟与一致性风险。",
    "事务日志保留变更顺序，便于下游按提交顺序消费。",
  ].join("\n");
  const reviewSource = [
    "Redis CDC 通过监听写操作日志捕获数据变更事件。",
    "变更事件投递到 Kafka，并按分区键维持顺序。",
    "消费者通过幂等处理保证最终一致性。",
  ].join("\n");
  const saveOnlySources = [
    "Schema Evolution 最佳实践\n向前兼容、双写过渡与 Backfill 应组合使用。",
    "Exactly Once 的边界\n端到端语义需要幂等写入、事务消息和可重放日志共同保证。\n它不是单一中间件开关。",
    "事件驱动架构的边界与治理\n事件契约、幂等、乱序与补偿需要进入日常治理流程。",
    "Kafka 分区策略设计\n分区键会同时影响吞吐、顺序和热点，需要结合访问模式选择。",
    "日志体系建设指南\n结构化采集、脱敏、关联与检索策略共同决定排障效率。\n关键链路要保留稳定追踪标识。",
    "分布式锁的正确使用姿势\n理解租约、续期、超时和并发控制，避免把锁当作一致性万能药。",
    "API 版本演进策略\n兼容性策略、灰度发布、可观测性和回滚能力缺一不可。",
    "数据一致性校验方案\n离线与在线校验结合，覆盖维度、抽样策略和告警闭环。\n校验结果必须可以追溯。",
    "Java 并发队列选型\n吞吐、延迟、公平性和背压目标会改变队列选择。",
    "Redis 高可用演练\n定期验证故障转移、客户端重连和数据恢复路径。\n演练结果进入运维复盘。",
  ];
  const sources = [detailSource, reviewSource, ...saveOnlySources];
  const records = sources.map((_, index) => ({
    id: stableUuid(1, index + 1),
    current_fragment_revision_id: stableUuid(2, index + 1),
    current_analysis_revision_id:
      index === 0 ? stableUuid(5, 1) : null,
    archived_at: null,
    created_at: FIXED_TIME,
    updated_at: `2099-08-09T${String(23 - index).padStart(2, "0")}:00:00.000Z`,
  }));
  const fragmentRevisions = sources.map((content, index) => ({
    id: stableUuid(2, index + 1),
    record_id: stableUuid(1, index + 1),
    revision_number: 1,
    content,
    grapheme_count: Array.from(content).length,
    created_at: FIXED_TIME,
  }));
  const analyses = [
    {
      id: stableUuid(5, 1),
      record_id: visualFixture.detailRecordId,
      fragment_revision_id: stableUuid(2, 1),
      text_model: "deepseek-v4-flash",
      title: "CDC 如何避免数据库轮询",
      summary:
        "CDC 通过读取数据库事务日志捕获增量变更，并以事件驱动方式向下游实时推送；它避免周期轮询产生的额外负载，降低同步延迟，并保留事务提交顺序以支持可靠消费。",
      status: "ACTIVE",
      generated_at: FIXED_TIME,
    },
    {
      id: stableUuid(5, 2),
      record_id: visualFixture.reviewRecordId,
      fragment_revision_id: stableUuid(2, 2),
      text_model: "deepseek-v4-flash",
      title: "Redis CDC 解决数据同步问题",
      summary:
        "Redis CDC 捕获变更后投递到 Kafka，并通过顺序消费与幂等处理维持一致性。",
      status: "GENERATED",
      generated_at: FIXED_TIME,
    },
  ];
  const pointInputs = [
    {
      recordIndex: 1,
      analysisIndex: 1,
      publication: "AUTO_PUBLISHED",
      source: detailSource,
      title: "CDC 捕获增量变化",
      body: "CDC 读取数据库事务日志获取增量变化，避免对业务库进行周期轮询。",
      quote: "CDC 通过读取数据库事务日志捕获增量变更，并以事件驱动方式实时推送。",
    },
    {
      recordIndex: 1,
      analysisIndex: 1,
      publication: "AUTO_PUBLISHED",
      source: detailSource,
      title: "轮询带来的性能问题",
      body: "传统轮询增加数据库负载，并会放大同步延迟和一致性风险。",
      quote: "传统轮询会增加数据库负载，也带来延迟与一致性风险。",
    },
    {
      recordIndex: 1,
      analysisIndex: 1,
      publication: "AUTO_PUBLISHED",
      source: detailSource,
      title: "事务日志保留提交顺序",
      body: "事务日志保留变更顺序，使下游可以按提交顺序消费事件。",
      quote: "事务日志保留变更顺序，便于下游按提交顺序消费。",
    },
    {
      recordIndex: 2,
      analysisIndex: 2,
      publication: "PENDING_REVIEW",
      source: reviewSource,
      title: "Redis CDC 监听变更日志",
      body: "Redis CDC 监听写操作日志并捕获数据变更事件。",
      quote: "Redis CDC 通过监听写操作日志捕获数据变更事件。",
    },
    {
      recordIndex: 2,
      analysisIndex: 2,
      publication: "PENDING_REVIEW",
      source: reviewSource,
      title: "Kafka 分区维持事件顺序",
      body: "变更事件投递到 Kafka 后，按分区键维持消费顺序。",
      quote: "变更事件投递到 Kafka，并按分区键维持顺序。",
    },
    {
      recordIndex: 2,
      analysisIndex: 2,
      publication: "PENDING_REVIEW",
      source: reviewSource,
      title: "幂等消费保证最终一致性",
      body: "消费者通过幂等处理避免重复事件破坏最终一致性。",
      quote: "消费者通过幂等处理保证最终一致性。",
    },
  ];
  const knowledgePoints = pointInputs.map((point, index) => ({
    id: stableUuid(6, index + 1),
    record_id: stableUuid(1, point.recordIndex),
    fragment_revision_id: stableUuid(2, point.recordIndex),
    analysis_revision_id: stableUuid(5, point.analysisIndex),
    position: (index % 3) + 1,
    ai_title: point.title,
    ai_body: point.body,
    publication_status: point.publication,
    usage_status: "INCLUDED",
    created_at: FIXED_TIME,
  }));
  const evidenceSpans = pointInputs.map((point, index) => {
    const start = point.source.indexOf(point.quote);

    return {
      id: stableUuid(7, index + 1),
      knowledge_point_id: stableUuid(6, index + 1),
      fragment_revision_id: stableUuid(2, point.recordIndex),
      position: 1,
      start_offset: start,
      end_offset: start + point.quote.length,
      quote: point.quote,
    };
  });
  const userAssignments = records.map((record, index) => ({
    id: stableUuid(4, index + 1),
    record_id: record.id,
    tag_id: stableUuid(3, (index % userTags.length) + 1),
    assigned_by: "USER",
    status: "ACTIVE",
    created_at: FIXED_TIME,
    knowledge_point_id: null,
    analysis_revision_id: null,
    raw_label: null,
  }));
  userAssignments.push(
    {
      id: stableUuid(4, 20),
      record_id: visualFixture.detailRecordId,
      tag_id: stableUuid(3, 2),
      assigned_by: "USER",
      status: "ACTIVE",
      created_at: FIXED_TIME,
      knowledge_point_id: null,
      analysis_revision_id: null,
      raw_label: null,
    },
    {
      id: stableUuid(4, 21),
      record_id: visualFixture.reviewRecordId,
      tag_id: stableUuid(3, 7),
      assigned_by: "USER",
      status: "ACTIVE",
      created_at: FIXED_TIME,
      knowledge_point_id: null,
      analysis_revision_id: null,
      raw_label: null,
    },
  );
  const aiAssignments = [1, 4].map((pointIndex, index) => ({
    id: stableUuid(4, 30 + index),
    record_id: null,
    tag_id: candidateTag.id,
    assigned_by: "AI",
    status: "ACTIVE",
    created_at: FIXED_TIME,
    knowledge_point_id: stableUuid(6, pointIndex),
    analysis_revision_id: knowledgePoints[pointIndex - 1]!.analysis_revision_id,
    raw_label: candidateTag.display_name,
  }));
  const snapshot = {
    formatVersion: 4,
    records,
    fragmentRevisions,
    tags: [...userTags, candidateTag],
    tagAssignments: [...userAssignments, ...aiAssignments],
    tagAliases: [],
    tagMerges: [],
    analyses,
    knowledgePoints,
    evidenceSpans,
    corrections: [],
    overviewCorrections: [],
    duplicateSuggestions: [],
    duplicateConsolidations: [],
    relationSuggestions: [],
    relationSuggestionEvidence: [],
    knowledgeRelations: [],
    coverageAnalyses: [],
    coverageAnalysisPoints: [],
    coverageAnalysisRecords: [],
    coverageAnalysisItems: [],
    coverageItemPoints: [],
    coverageItemRecords: [],
  };
  const manifest = {
    formatVersion: 4,
    recordCount: records.length,
    included: ["markdown", "domain_json"],
    excluded: [
      "model_credentials",
      "embeddings",
      "search_indexes",
      "ai_tasks",
      "logs",
    ],
  };

  return createZip([
    {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest), "utf8"),
    },
    {
      name: "domain.json",
      data: Buffer.from(JSON.stringify(snapshot), "utf8"),
    },
    { name: "README.md", data: Buffer.from("# Visual fixture\n", "utf8") },
    ...records.map((record) => ({
      name: `records/${record.id}.md`,
      data: Buffer.from(`# Visual record ${record.id}\n`, "utf8"),
    })),
  ]);
}

function stableUuid(scope: number, index: number): string {
  const hex = createHash("sha256")
    .update(`knowledge-visual-matrix:${scope}:${index}`)
    .digest("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

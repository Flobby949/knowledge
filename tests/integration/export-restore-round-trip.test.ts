import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { createZip, readStoredZip } from "../../src/zip-archive.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type PublicExport = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  completedAt?: string;
  downloadUrl?: string;
  manifest?: {
    formatVersion: number;
    recordCount: number;
    included: string[];
    excluded: string[];
  };
};

type DomainJson = {
  formatVersion: number;
  records: Array<
    Record<string, unknown> & {
      id: string;
      current_fragment_revision_id: string;
      archived_at: string | null;
    }
  >;
  fragmentRevisions: Array<
    Record<string, unknown> & { id: string; content: string }
  >;
  tags: Array<Record<string, unknown> & { id: string }>;
  tagAliases: Array<
    Record<string, unknown> & { id: string; tag_id: string; display_name: string }
  >;
  tagMerges: Array<
    Record<string, unknown> & {
      id: string;
      operation_id: string;
      source_tag_id: string;
      target_tag_id: string;
      undone_at: string | null;
    }
  >;
  tagAssignments: Array<
    Record<string, unknown> & {
      id: string;
      record_id: string | null;
      knowledge_point_id: string | null;
      assigned_by: "USER" | "AI";
      analysis_revision_id: string | null;
      raw_label: string | null;
    }
  >;
  analyses: Array<Record<string, unknown> & { id: string }>;
  knowledgePoints: Array<
    Record<string, unknown> & { id: string; analysis_revision_id: string }
  >;
  evidenceSpans: Array<
    Record<string, unknown> & { id: string; knowledge_point_id: string }
  >;
  corrections: Array<Record<string, unknown> & { knowledge_point_id: string }>;
  overviewCorrections: Array<
    Record<string, unknown> & {
      record_id: string;
      analysis_revision_id: string;
    }
  >;
  duplicateSuggestions: Array<Record<string, unknown>>;
  duplicateConsolidations: Array<Record<string, unknown>>;
  relationSuggestions: Array<Record<string, unknown>>;
  relationSuggestionEvidence: Array<Record<string, unknown>>;
  knowledgeRelations: Array<Record<string, unknown>>;
  coverageAnalyses: Array<Record<string, unknown>>;
  coverageAnalysisPoints: Array<Record<string, unknown>>;
  coverageAnalysisRecords: Array<Record<string, unknown>>;
  coverageAnalysisItems: Array<Record<string, unknown>>;
  coverageItemPoints: Array<Record<string, unknown>>;
  coverageItemRecords: Array<Record<string, unknown>>;
  concepts: Array<Record<string, unknown>>;
  conceptRevisions: Array<Record<string, unknown>>;
  conceptMemberships: Array<Record<string, unknown>>;
  conceptActivity: Array<Record<string, unknown>>;
  conceptRelationSuggestions: Array<Record<string, unknown>>;
  conceptRelations: Array<Record<string, unknown>>;
};

describe("complete export and empty-instance restore", () => {
  let sourceApp: FastifyInstance;
  let targetApp: FastifyInstance;
  let sourceDatabase: PreparedTestDatabase;
  let targetDatabase: PreparedTestDatabase;
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));

  beforeAll(async () => {
    sourceDatabase = prepareTestDatabase();
    targetDatabase = prepareTestDatabase();
    sourceApp = await buildApp({
      databaseUrl: sourceDatabase.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis: async ({ sourceText }) => generatedAnalysis(sourceText),
      testModelEndpoint,
    });
    targetApp = await buildApp({
      databaseUrl: targetDatabase.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis: async () => {
        throw new Error("restore must not call an analysis model");
      },
      testModelEndpoint,
    });
    await Promise.all([sourceApp.ready(), targetApp.ready()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([sourceApp?.close(), targetApp?.close()]);
    sourceDatabase?.dispose();
    targetDatabase?.dispose();
  }, 30_000);

  it("round-trips versioned domain data without runtime or credential data", async () => {
    const secrets = await activateLocalModelConfiguration(sourceApp);
    const marker = `export-restore-${crypto.randomUUID()}`;
    const tagName = `Unicode 标签 ${marker}`;
    const sourceV1 = "  第一版 👨‍👩‍👧‍👦 e\u0301\n<原样正文>  ";
    const sourceV2 =
      "第二版 🧠 e\u0301\nCDC 保留 Unicode 原文。\n```md\n<script>不能执行</script>\n```\t";
    const correctedTitle = "Unicode 原文保留机制（用户修正）";
    const correctedBody =
      "CDC 保留 Unicode 原文。这是用户修正层，不改变 AI 原值与证据。";
    const correctedOverviewTitle = "Unicode 整体标题（用户修正）";
    const correctedOverviewSummary = "用户补充的 Unicode 整体摘要。";
    const created = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceV1,
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: {
        id: string;
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const recordId = createdBody.record.id;
    const userTag = createdBody.record.myTags[0]!;
    const aliasName = `Unicode 别名 ${marker}`;
    const alias = await sourceApp.inject({
      method: "POST",
      url: `/api/v1/tags/${userTag.id}/aliases`,
      payload: { name: aliasName },
    });

    expect(alias.statusCode).toBe(201);

    const aliasId = (alias.json() as { alias: { id: string } }).alias.id;
    const mergeSourceName = `Unicode 同义来源 ${marker}`;
    const mergeSourceCreated = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name: mergeSourceName },
    });

    expect(mergeSourceCreated.statusCode).toBe(201);

    const mergeSourceTag = (
      mergeSourceCreated.json() as { tag: { id: string; name: string } }
    ).tag;
    const mergeCreated = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/tag-merges",
      payload: {
        sourceTagIds: [mergeSourceTag.id],
        targetTagId: userTag.id,
      },
    });

    expect(mergeCreated.statusCode).toBe(201);

    const mergeOperationId = (
      mergeCreated.json() as { merge: { id: string } }
    ).merge.id;
    const updated = await sourceApp.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}`,
      payload: {
        text: sourceV2,
        myTags: [{ id: userTag.id }],
        processing: "save_only",
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      record: { id: recordId, textVersion: 2 },
    });

    const organized = await sourceApp.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(organized.statusCode).toBe(202);

    const taskId = (organized.json() as { task: PublicTask }).task.id;

    await waitForSucceededTask(sourceApp, taskId);

    const sourceDetail = await getRecordDetail(sourceApp, recordId);
    const sourceItem = sourceDetail.organizedItems[0]!;
    const overviewCorrected = await sourceApp.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}/overview-correction`,
      payload: {
        title: correctedOverviewTitle,
        summary: correctedOverviewSummary,
      },
    });

    expect(overviewCorrected.statusCode).toBe(200);

    const corrected = await sourceApp.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}/organized-items/${sourceItem.id}/correction`,
      payload: { title: correctedTitle, body: correctedBody },
    });

    expect(corrected.statusCode).toBe(200);

    const archived = await sourceApp.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      record: { id: recordId, lifecycle: "archived" },
    });

    const sourceHistory = await getOriginalHistory(sourceApp, recordId);
    const sourceV1Entry = sourceHistory.find((entry) => entry.version === 1)!;
    const sourceV1Snapshot = await getHistorySnapshot(
      sourceApp,
      recordId,
      sourceV1Entry.id,
    );

    expect(sourceV1Snapshot.snapshot.text).toBe(sourceV1);

    const requestedExport = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/exports",
    });

    expect(requestedExport.statusCode).toBe(202);

    const queuedExport = (requestedExport.json() as { export: PublicExport })
      .export;

    expect(queuedExport).toMatchObject({
      id: expect.any(String),
      status: "queued",
    });

    const completedExport = await waitForSucceededExport(
      sourceApp,
      queuedExport.id,
    );

    expect(completedExport).toMatchObject({
      id: queuedExport.id,
      status: "succeeded",
      completedAt: expect.any(String),
      downloadUrl: expect.any(String),
      manifest: {
        formatVersion: 10,
        recordCount: 1,
        included: expect.arrayContaining(["markdown", "domain_json"]),
        excluded: expect.arrayContaining([
          "model_credentials",
          "embeddings",
          "search_indexes",
          "ai_tasks",
          "logs",
        ]),
      },
    });

    if (!completedExport.downloadUrl) {
      throw new Error("successful export must provide a download URL");
    }

    const download = await sourceApp.inject({
      method: "GET",
      url: completedExport.downloadUrl,
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(download.headers["content-disposition"]).toMatch(
      /^attachment;.*\.zip/iu,
    );

    const archive = download.rawPayload;

    expect(archive.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );

    for (const excludedValue of Object.values(secrets)) {
      expect(archive.includes(Buffer.from(excludedValue))).toBe(false);
    }

    const entries = readStoredZip(archive);
    const recordMarkdownName = `records/${recordId}.md`;
    const recordMarkdown = entries.get(recordMarkdownName)?.toString("utf8");
    const domain = parseDomainJson(entries);

    expect([...entries.keys()].sort()).toEqual(
      ["README.md", "domain.json", "manifest.json", recordMarkdownName].sort(),
    );
    expect(recordMarkdown).toBeDefined();

    if (!recordMarkdown) {
      throw new Error("export must contain one Markdown file per record");
    }

    expect(recordMarkdown).toContain(`# 记录 ${recordId}`);
    expect(recordMarkdown).toContain(`- 稳定记录 ID: \`${recordId}\``);
    expect(recordMarkdown).toContain("- 归档状态: `ARCHIVED`");
    expect(recordMarkdown).toContain("## 我的标签");
    expect(recordMarkdown).toContain(tagName);
    expect(recordMarkdown).toContain("## 当前有效 AI 整理");
    expect(readFencedText(recordMarkdown, "### AI 标题")).toBe(
      "Unicode 原文整理",
    );
    expect(readFencedText(recordMarkdown, "### AI 摘要")).toBe(
      "CDC 保留 Unicode 原文。",
    );
    expect(readFencedText(recordMarkdown, "### 用户修正的整体标题")).toBe(
      correctedOverviewTitle,
    );
    expect(readFencedText(recordMarkdown, "### 用户修正的整体摘要")).toBe(
      correctedOverviewSummary,
    );
    expect(readFencedText(recordMarkdown, "### 原文 v1")).toBe(sourceV1);
    expect(readFencedText(recordMarkdown, "### 原文 v2 · 当前")).toBe(
      sourceV2,
    );
    expect(recordMarkdown).toContain("## 当前分析的知识点");
    expect(recordMarkdown).toContain(`- 稳定知识点 ID: \`${sourceItem.id}\``);
    expect(recordMarkdown).toContain("- 发布状态: `CONFIRMED`");
    expect(recordMarkdown).toContain("- 使用状态: `INCLUDED`");
    expect(readFencedText(recordMarkdown, "#### AI 原始标题")).toBe(
      "Unicode 原文保留机制",
    );
    expect(readFencedText(recordMarkdown, "#### AI 原始正文")).toBe(
      "CDC 保留 Unicode 原文。",
    );
    expect(readFencedText(recordMarkdown, "#### 用户修正标题")).toBe(
      correctedTitle,
    );
    expect(readFencedText(recordMarkdown, "#### 用户修正正文")).toBe(
      correctedBody,
    );
    expect(recordMarkdown).toContain("#### AI 候选标签");
    expect(recordMarkdown).toContain("Unicode");
    expect(recordMarkdown).toContain("#### Evidence 1");
    expect(readFencedText(recordMarkdown, "##### 证据原文")).toBe(
      "CDC 保留 Unicode 原文。",
    );

    expect(Object.keys(domain).sort()).toEqual(
      [
        "analyses",
        "corrections",
        "textHighlights",
        "evidenceSpans",
        "formatVersion",
        "fragmentRevisions",
        "knowledgePoints",
        "overviewCorrections",
        "duplicateSuggestions",
        "duplicateConsolidations",
        "relationSuggestions",
        "relationSuggestionEvidence",
        "knowledgeRelations",
        "coverageAnalyses",
        "coverageAnalysisPoints",
        "coverageAnalysisRecords",
        "coverageAnalysisItems",
        "coverageItemPoints",
        "coverageItemRecords",
        "concepts",
        "conceptRevisions",
        "conceptMemberships",
        "conceptActivity",
        "conceptCandidateScans",
        "conceptCandidateInputs",
        "conceptCandidates",
        "conceptCandidateMembers",
        "conceptCandidateDecisionMembers",
        "conceptRelationSuggestions",
        "conceptRelations",
        "records",
        "tagAssignments",
        "tagAliases",
        "tagMerges",
        "tags",
      ].sort(),
    );
    expect(
      domain.fragmentRevisions.map((revision) => revision.content),
    ).toEqual([sourceV1, sourceV2]);
    expect(domain.records).toContainEqual(
      expect.objectContaining({
        id: recordId,
        archived_at: expect.any(String),
      }),
    );
    expect(domain.tagAliases).toEqual([
      expect.objectContaining({
        id: aliasId,
        tag_id: userTag.id,
        display_name: aliasName,
      }),
    ]);
    expect(domain.tagMerges).toEqual([
      expect.objectContaining({
        operation_id: mergeOperationId,
        source_tag_id: mergeSourceTag.id,
        target_tag_id: userTag.id,
        undone_at: null,
      }),
    ]);
    expect(domain.corrections).toContainEqual(
      expect.objectContaining({
        knowledge_point_id: sourceItem.id,
        title: correctedTitle,
        body: correctedBody,
      }),
    );
    expect(domain.overviewCorrections).toContainEqual(
      expect.objectContaining({
        record_id: recordId,
        analysis_revision_id: domain.knowledgePoints.find(
          (point) => point.id === sourceItem.id,
        )?.analysis_revision_id,
        title: correctedOverviewTitle,
        summary: correctedOverviewSummary,
        updated_at: expect.any(String),
      }),
    );
    expect(domain.knowledgePoints).toContainEqual(
      expect.objectContaining({
        id: sourceItem.id,
        publication_status: "CONFIRMED",
        usage_status: "INCLUDED",
        ai_title: "Unicode 原文保留机制",
        ai_body: "CDC 保留 Unicode 原文。",
      }),
    );
    expect(domain.evidenceSpans).toContainEqual(
      expect.objectContaining({
        knowledge_point_id: sourceItem.id,
        quote: "CDC 保留 Unicode 原文。",
      }),
    );
    expect(JSON.stringify(domain)).not.toMatch(
      /credential_ciphertext|api[_-]?key|task_id|base_url|embedding|search_index|log/iu,
    );

    const tamperedPackages = [
      mutatePackageFormatVersion(archive, 3),
      mutateDomainJson(archive, (snapshot) => {
        snapshot.records[0]!.current_fragment_revision_id = crypto.randomUUID();
      }),
      mutateDomainJson(archive, (snapshot) => {
        snapshot.knowledgePoints[0]!.analysis_revision_id = crypto.randomUUID();
      }),
      mutateDomainJson(archive, (snapshot) => {
        snapshot.evidenceSpans[0]!.knowledge_point_id = crypto.randomUUID();
      }),
      mutateDomainJson(archive, (snapshot) => {
        snapshot.overviewCorrections[0]!.analysis_revision_id =
          crypto.randomUUID();
      }),
      mutateDomainJson(archive, (snapshot) => {
        snapshot.fragmentRevisions.push({ ...snapshot.fragmentRevisions[0]! });
      }),
      mutateDomainJson(archive, (snapshot) => {
        snapshot.tagAssignments = snapshot.tagAssignments.filter(
          (assignment) => assignment.record_id !== recordId,
        );
      }),
      mutateDomainJson(archive, (snapshot) => {
        const assignment = snapshot.tagAssignments.find(
          (candidate) => candidate.assigned_by === "AI",
        )!;

        assignment.raw_label = null;
      }),
      mutateDomainJson(archive, (snapshot) => {
        const assignment = snapshot.tagAssignments.find(
          (candidate) => candidate.assigned_by === "AI",
        )!;
        const sourceAnalysis = snapshot.analyses.find(
          (analysis) => analysis.id === assignment.analysis_revision_id,
        )!;
        const otherAnalysisId = crypto.randomUUID();

        snapshot.analyses.push({
          ...sourceAnalysis,
          id: otherAnalysisId,
          status: "GENERATED",
        });
        assignment.analysis_revision_id = otherAnalysisId;
      }),
      mutateDomainJson(archive, (snapshot) => {
        const assignment = snapshot.tagAssignments.find(
          (candidate) => candidate.assigned_by === "USER",
        )!;

        assignment.analysis_revision_id = snapshot.analyses[0]!.id;
        assignment.raw_label = "不应属于用户关联";
      }),
    ];

    for (const tampered of tamperedPackages) {
      await expectInvalidRestorePackage(targetApp, tampered);
    }

    const stillEmpty = await targetApp.inject({
      method: "GET",
      url: "/api/v1/records",
    });
    const stillEmptyTags = await targetApp.inject({
      method: "GET",
      url: "/api/v1/tags",
    });

    expect(stillEmpty.statusCode).toBe(200);
    expect(stillEmptyTags.statusCode).toBe(200);
    expect(stillEmpty.json()).toMatchObject({ items: [] });
    expect(stillEmptyTags.json()).toMatchObject({ items: [] });

    const inspection = await inspectRestorePackage(targetApp, archive);

    expect(inspection).toMatchObject({
      id: expect.any(String),
      status: "valid",
      formatVersion: 10,
      recordCount: 1,
      canRestore: true,
    });

    const restored = await targetApp.inject({
      method: "POST",
      url: "/api/v1/restores",
      payload: { inspectionId: inspection.id },
    });

    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({
      restore: {
        id: expect.any(String),
        status: "succeeded",
        recordCount: 1,
      },
    });

    const restoredList = await targetApp.inject({
      method: "GET",
      url: "/api/v1/records",
    });

    expect(restoredList.statusCode).toBe(200);
    expect(restoredList.json()).toMatchObject({
      items: [],
    });

    const restoredDetail = await getRecordDetail(targetApp, recordId);

    expect(restoredDetail).toMatchObject({
      id: recordId,
      lifecycle: "archived",
      editable: {
        text: sourceV2,
        textVersion: 2,
        myTags: [{ id: userTag.id, name: tagName }],
      },
      presentation: {
        title: correctedOverviewTitle,
        summary: correctedOverviewSummary,
        source: "user_correction",
        aiOriginal: {
          title: "Unicode 原文整理",
          summary: "CDC 保留 Unicode 原文。",
        },
        correction: expect.objectContaining({
          title: correctedOverviewTitle,
          summary: correctedOverviewSummary,
          updatedAt: expect.any(String),
        }),
      },
      organizedItems: [
        expect.objectContaining({
          id: sourceItem.id,
          title: correctedTitle,
          body: correctedBody,
          publicationStatus: "CONFIRMED",
          usageStatus: "INCLUDED",
          aiOriginal: {
            title: "Unicode 原文保留机制",
            body: "CDC 保留 Unicode 原文。",
          },
          correction: expect.objectContaining({
            title: correctedTitle,
            body: correctedBody,
          }),
        }),
      ],
    });

    const unarchived = await targetApp.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/restore`,
    });

    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json()).toMatchObject({
      record: { id: recordId, lifecycle: "active" },
    });

    const visibleRestoredList = await targetApp.inject({
      method: "GET",
      url: "/api/v1/records",
    });

    expect(visibleRestoredList.statusCode).toBe(200);
    expect(visibleRestoredList.json()).toMatchObject({
      items: [expect.objectContaining({ id: recordId, textVersion: 2 })],
    });
    expect(await getOriginalHistory(targetApp, recordId)).toEqual(sourceHistory);
    expect(
      await getHistorySnapshot(targetApp, recordId, sourceV1Entry.id),
    ).toEqual(sourceV1Snapshot);

    const restoredTags = await targetApp.inject({
      method: "GET",
      url:
        "/api/v1/tags?approval=user_approved&q=" +
        encodeURIComponent(marker),
    });

    expect(restoredTags.statusCode).toBe(200);
    expect(restoredTags.json()).toMatchObject({
      items: [
        {
          id: userTag.id,
          name: tagName,
          origin: "user_created",
          approvalStatus: "user_approved",
          recordCount: 1,
        },
      ],
    });

    const restoredAliasLookup = await targetApp.inject({
      method: "GET",
      url:
        "/api/v1/tags?approval=user_approved&q=" +
        encodeURIComponent(aliasName),
    });
    const restoredMergedLookup = await targetApp.inject({
      method: "GET",
      url:
        "/api/v1/tags?approval=user_approved&q=" +
        encodeURIComponent(mergeSourceName),
    });

    expect(restoredAliasLookup.json()).toMatchObject({
      items: [expect.objectContaining({ id: userTag.id })],
    });
    expect(restoredMergedLookup.json()).toMatchObject({
      items: [expect.objectContaining({ id: userTag.id })],
    });

    const undoRestoredMerge = await targetApp.inject({
      method: "DELETE",
      url: `/api/v1/tag-merges/${mergeOperationId}`,
    });

    expect(undoRestoredMerge.statusCode).toBe(204);

    const restoredSourceAfterUndo = await targetApp.inject({
      method: "GET",
      url:
        "/api/v1/tags?approval=user_approved&q=" +
        encodeURIComponent(mergeSourceName),
    });

    expect(restoredSourceAfterUndo.json()).toMatchObject({
      items: [
        expect.objectContaining({
          id: mergeSourceTag.id,
          name: mergeSourceName,
        }),
      ],
    });

    const restoredSearch = await targetApp.inject({
      method: "GET",
      url: "/api/v1/search?q=" + encodeURIComponent("原文保留机制"),
    });

    expect(restoredSearch.statusCode).toBe(200);
    expect(restoredSearch.json()).toMatchObject({
      items: [
        expect.objectContaining({
          record: expect.objectContaining({ id: recordId }),
          match: expect.objectContaining({ reason: "knowledge_point" }),
        }),
      ],
    });

    const restoredOverviewSearch = await targetApp.inject({
      method: "GET",
      url: "/api/v1/search?q=" + encodeURIComponent(correctedOverviewTitle),
    });

    expect(restoredOverviewSearch.statusCode).toBe(200);
    expect(restoredOverviewSearch.json()).toMatchObject({
      items: [
        expect.objectContaining({
          record: expect.objectContaining({ id: recordId }),
        }),
      ],
    });

    const deleted = await targetApp.inject({
      method: "DELETE",
      url: `/api/v1/records/${recordId}`,
    });

    expect(deleted.statusCode).toBe(204);

    const emptyRecordList = await targetApp.inject({
      method: "GET",
      url: "/api/v1/records",
    });
    const retainedTagList = await targetApp.inject({
      method: "GET",
      url:
        "/api/v1/tags?approval=user_approved&q=" +
        encodeURIComponent(marker),
    });

    expect(emptyRecordList.statusCode).toBe(200);
    expect(retainedTagList.statusCode).toBe(200);
    expect(emptyRecordList.json()).toMatchObject({ items: [] });
    expect(retainedTagList.json()).toMatchObject({
      items: [
        expect.objectContaining({
          id: mergeSourceTag.id,
          recordCount: 0,
        }),
        expect.objectContaining({
          id: userTag.id,
          recordCount: 0,
        }),
      ],
    });

    const blockedInspection = await inspectRestorePackage(targetApp, archive);

    expect(blockedInspection).toMatchObject({
      status: "valid",
      canRestore: false,
      blockingReason: "INSTANCE_NOT_EMPTY",
    });

    const rejected = await targetApp.inject({
      method: "POST",
      url: "/api/v1/restores",
      payload: { inspectionId: blockedInspection.id },
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({
      error: {
        code: "RESTORE_INSTANCE_NOT_EMPTY",
        message: expect.any(String),
      },
    });
  });
});

function parseDomainJson(entries: Map<string, Buffer>): DomainJson {
  const domainJson = entries.get("domain.json");

  if (!domainJson) {
    throw new Error("domain.json is missing from export");
  }

  return JSON.parse(domainJson.toString("utf8")) as DomainJson;
}

function mutateDomainJson(
  archive: Buffer,
  mutate: (snapshot: DomainJson) => void,
): Buffer {
  const entries = readStoredZip(archive);
  const snapshot = structuredClone(parseDomainJson(entries));

  mutate(snapshot);
  entries.set(
    "domain.json",
    Buffer.from(JSON.stringify(snapshot), "utf8"),
  );

  return createZip(
    [...entries].map(([name, data]) => ({ name, data })),
  );
}

function mutatePackageFormatVersion(
  archive: Buffer,
  formatVersion: number,
): Buffer {
  const entries = readStoredZip(archive);
  const domain = structuredClone(parseDomainJson(entries));
  const manifestEntry = entries.get("manifest.json");

  if (!manifestEntry) {
    throw new Error("manifest.json is missing from export");
  }

  const publicManifest = JSON.parse(manifestEntry.toString("utf8")) as Record<
    string,
    unknown
  >;

  domain.formatVersion = formatVersion;
  publicManifest.formatVersion = formatVersion;
  entries.set(
    "domain.json",
    Buffer.from(JSON.stringify(domain), "utf8"),
  );
  entries.set(
    "manifest.json",
    Buffer.from(JSON.stringify(publicManifest), "utf8"),
  );

  return createZip([...entries].map(([name, data]) => ({ name, data })));
}

async function expectInvalidRestorePackage(
  app: FastifyInstance,
  archive: Buffer,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/restores/inspect",
    headers: { "content-type": "application/zip" },
    payload: archive,
  });

  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual({
    error: {
      code: "RESTORE_PACKAGE_INVALID",
      message: expect.any(String),
    },
  });
}

function readFencedText(markdown: string, heading: string): string {
  const headingStart = markdown.indexOf(`${heading}\n`);

  if (headingStart < 0) {
    throw new Error(`Markdown heading not found: ${heading}`);
  }

  const section = markdown.slice(headingStart + heading.length + 1);
  const opening = /^(`{3,})text$/mu.exec(section);

  if (!opening || opening.index === undefined) {
    throw new Error(`Raw text fence not found after heading: ${heading}`);
  }

  const fence = opening[1]!;
  const contentStart = opening.index + opening[0].length + 1;
  const closingStart = section.indexOf(`\n${fence}`, contentStart);

  if (closingStart < 0) {
    throw new Error(`Raw text fence is not closed after heading: ${heading}`);
  }

  return section.slice(contentStart, closingStart);
}

function generatedAnalysis(sourceText: string) {
  const quote = "CDC 保留 Unicode 原文。";
  const start = sourceText.indexOf(quote);

  if (start < 0) {
    throw new Error("analysis received an unexpected source revision");
  }

  return {
    title: "Unicode 原文整理",
    summary: quote,
    knowledgePoints: [
      {
        title: "Unicode 原文保留机制",
        body: quote,
        candidateTags: ["Unicode"],
        evidenceSpans: [
          { quote, start, end: start + quote.length },
        ],
      },
    ],
  };
}

async function activateLocalModelConfiguration(app: FastifyInstance) {
  const secrets = {
    textApiKey: `local-export-text-${crypto.randomUUID()}`,
    textBaseUrl: `https://text-${crypto.randomUUID()}.invalid/v1`,
    embeddingApiKey: `local-export-embedding-${crypto.randomUUID()}`,
    embeddingBaseUrl: `https://embedding-${crypto.randomUUID()}.invalid/v1`,
    embeddingModel: `private-embedding-${crypto.randomUUID()}`,
  };
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: secrets.textBaseUrl,
        model: "deepseek-v4-flash",
        apiKey: secrets.textApiKey,
      },
      embedding: {
        baseUrl: secrets.embeddingBaseUrl,
        model: secrets.embeddingModel,
        apiKey: secrets.embeddingApiKey,
      },
    },
  });

  expect(saved.statusCode).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    const tested = await app.inject({
      method: "POST",
      url: `/api/v1/model-config/draft/tests/${kind}`,
    });

    expect(tested.statusCode).toBe(200);
  }

  const activated = await app.inject({
    method: "POST",
    url: "/api/v1/model-config/draft/activate",
  });

  expect(activated.statusCode).toBe(200);

  return secrets;
}

async function waitForSucceededTask(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const task = (response.json() as { task: PublicTask }).task;

    if (task.status === "succeeded") {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not succeed in time`);
}

async function waitForSucceededExport(
  app: FastifyInstance,
  exportId: string,
): Promise<PublicExport> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}`,
    });

    expect(response.statusCode).toBe(200);

    const current = (response.json() as { export: PublicExport }).export;

    if (current.status === "succeeded") {
      return current;
    }

    if (current.status === "failed") {
      throw new Error(`export ${exportId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`export ${exportId} did not succeed in time`);
}

async function inspectRestorePackage(app: FastifyInstance, archive: Buffer) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/restores/inspect",
    headers: { "content-type": "application/zip" },
    payload: archive,
  });

  expect(response.statusCode).toBe(200);

  return (
    response.json() as {
      inspection: {
        id: string;
        status: "valid";
        formatVersion: number;
        recordCount: number;
        canRestore: boolean;
        blockingReason?: "INSTANCE_NOT_EMPTY";
      };
    }
  ).inspection;
}

async function getRecordDetail(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    id: string;
    lifecycle: "active" | "archived";
    editable: {
      text: string;
      textVersion: number;
      myTags: Array<{ id: string; name: string }>;
    };
    presentation: { title: string; summary: string; source: "ai" };
    organizedItems: Array<{
      id: string;
      title: string;
      body: string;
      publicationStatus: string;
      usageStatus: string;
      aiOriginal: { title: string; body: string };
      correction: null | { title: string; body: string; updatedAt: string };
    }>;
  };
}

async function getOriginalHistory(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}/history`,
  });

  expect(response.statusCode).toBe(200);

  const body = response.json() as {
    items: Array<{
      id: string;
      type: "original" | "organization";
      version?: number;
      createdAt: string;
      isCurrent: boolean;
    }>;
  };

  return body.items.filter(
    (entry): entry is typeof entry & { type: "original"; version: number } =>
      entry.type === "original",
  );
}

async function getHistorySnapshot(
  app: FastifyInstance,
  recordId: string,
  entryId: string,
) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}/history/${entryId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    id: string;
    type: "original";
    version: number;
    createdAt: string;
    snapshot: { text: string };
    currentVersion: number;
  };
}

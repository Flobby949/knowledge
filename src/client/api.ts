export interface TagChip {
  id: string;
  name: string;
}

export type RecordTagSelection = TagChip | string;

export interface TagListItem extends TagChip {
  origin: "user_created" | "ai_created";
  approvalStatus: "archived" | "candidate" | "user_approved";
  recordCount: number;
}

export interface UserTagListItem extends TagListItem {
  approvalStatus: "user_approved";
}

export interface TagDetail {
  tag: TagListItem;
  aliases: Array<{ id: string; name: string }>;
  mergedSources: Array<{ id: string; mergeId: string; name: string }>;
  records: Array<{
    record: { id: string; title: string };
    sourceSummary: {
      fromMyTags: boolean;
      activeKnowledgePointCount: number;
    };
    knowledgePoints: Array<{
      id: string;
      title: string;
      suppressed: boolean;
    }>;
  }>;
}

export interface DuplicateSuggestionSource {
  changedSinceSuggestion: boolean;
  current: boolean;
  excerpt: string;
  id: string;
  recordId: string;
  recordTitle: string;
  title: string;
  type: "knowledge_point" | "original";
}

export interface DuplicateSuggestion {
  canDecide: boolean;
  consolidationId: string | null;
  createdAt: string;
  id: string;
  kind: "exact" | "semantic";
  primarySourceId: string | null;
  reason: string;
  score: number;
  sources: [DuplicateSuggestionSource, DuplicateSuggestionSource];
  status: "accepted" | "pending_review" | "rejected" | "removed";
}

export interface DuplicateScanResult {
  exactCandidates: number;
  pendingSuggestions: number;
  semanticCandidates: number;
  semanticReadySources: number;
  semanticStatus: "ready" | "unavailable";
}

export interface RelationSuggestionPoint {
  body: string;
  changedSinceSuggestion: boolean;
  current: boolean;
  evidence: Array<{ id: string; quote: string }>;
  id: string;
  recordId: string;
  recordTitle: string;
  title: string;
}

export type KnowledgeRelationType =
  | "analogy"
  | "applies"
  | "contrasts"
  | "extends"
  | "prerequisite"
  | "similar";

export interface RelationSuggestion {
  canDecide: boolean;
  confidence: number;
  description: string;
  id: string;
  model: { configurationVersion: number; name: string };
  needsReview: boolean;
  reason: string;
  relation: null | {
    description: string;
    id: string;
    removed: boolean;
    type: KnowledgeRelationType;
  };
  source: RelationSuggestionPoint;
  status: "confirmed" | "pending_review" | "rejected" | "removed";
  target: RelationSuggestionPoint;
  type: KnowledgeRelationType;
}

export interface CoverageSource {
  excerpt: string;
  id: string;
  organization: "organized" | "original";
  tags: string[];
  title: string;
  updatedAt: string;
}

export interface CoverageAnalysisSource {
  changedSinceAnalysis: boolean;
  current: boolean;
  excerpt: string;
  id: string;
  recordId: string;
  title: string;
}

export interface CoverageAnalysis {
  advisory: true;
  attemptCount: number;
  canRetry: boolean;
  caveat: string | null;
  completedAt: string | null;
  covered: Array<{
    assessment: string;
    id: string;
    kind: "covered";
    recommendation: null;
    sources: CoverageAnalysisSource[];
    title: string;
  }>;
  createdAt: string;
  failure: null | { code: string; message: string };
  frameworkSummary: string | null;
  id: string;
  inputChanged: boolean;
  inputCount: number;
  inputKind: "knowledge_points" | "records";
  model: { configurationVersion: number; name: string };
  possibleGaps: Array<{
    assessment: string;
    id: string;
    kind: "possible_gap";
    recommendation: string;
    sources: [];
    title: string;
  }>;
  sources: CoverageAnalysisSource[];
  startedAt: string | null;
  status: "failed" | "queued" | "running" | "succeeded";
  topic: string;
}

export interface RecordCard {
  id: string;
  title: string;
  preview: string;
  myTags: TagChip[];
  lifecycle: "active" | "archived";
  organization: {
    view: "original" | "organized";
    activity: "idle" | "queued" | "running" | "failed";
  };
  textVersion: number;
  updatedAt: string;
}

export interface RecordDetail {
  id: string;
  lifecycle: "active" | "archived";
  presentation: {
    title: string;
    summary: string | null;
    source: "original" | "ai" | "user_correction";
    aiOriginal?: { title: string; summary: string };
    correction?: {
      title: string;
      summary: string;
      updatedAt: string;
    };
  };
  editable: {
    text: string;
    textVersion: number;
    myTags: TagChip[];
  };
  organization: {
    view: "original" | "organized";
    activity: "idle" | "queued" | "running" | "failed";
    task: AiTask | null;
    candidate?: OrganizationCandidate;
  };
  organizedItems: OrganizedItem[];
  excludedItems: OrganizedItem[];
  updatedAt: string;
}

export interface OrganizationCandidate {
  id: string;
  reason: "reanalysis" | "source_updated";
  sourceTextVersion: number;
  presentation: { title: string; summary: string };
  organizedItems: OrganizedItem[];
}

export interface OrganizedItem {
  id: string;
  title: string;
  body: string;
  publicationStatus:
    | "AI_CREATED"
    | "PENDING_REVIEW"
    | "AUTO_PUBLISHED"
    | "CONFIRMED"
    | "REJECTED";
  usageStatus: "INCLUDED" | "EXCLUDED";
  tags: TagChip[];
  evidenceCount: number;
  aiOriginal: { title: string; body: string };
  correction: null | {
    title: string;
    body: string;
    updatedAt: string;
  };
}

export interface EvidenceSpan {
  quote: string;
  start: number;
  end: number;
  sourceTextVersion: number;
}

export interface ReviewQueueItem {
  record: { id: string; title: string };
  pendingCount: number;
}

export interface TagFieldItem {
  id: string;
  name: string;
  approval: "approved" | "candidate";
  recordCount: number;
}

export interface AiTask {
  id: string;
  recordId: string;
  handling: "automatic" | "review";
  status: "queued" | "running" | "succeeded" | "failed";
  failure?: { code: string; message: string };
}

export interface OriginalRecordHistoryEntry {
  id: string;
  type: "original";
  version: number;
  createdAt: string;
  isCurrent: boolean;
}

export interface OrganizationRecordHistoryEntry {
  id: string;
  type: "organization";
  sourceTextVersion: number;
  status: AnalysisHistoryStatus;
  createdAt: string;
  isCurrent: boolean;
}

export type RecordHistoryEntry =
  | OriginalRecordHistoryEntry
  | OrganizationRecordHistoryEntry;

export interface OriginalRecordHistorySnapshot {
  id: string;
  type: "original";
  version: number;
  createdAt: string;
  snapshot: { text: string };
  currentVersion: number;
}

export interface OrganizationRecordHistorySnapshot {
  id: string;
  type: "organization";
  sourceTextVersion: number;
  status: AnalysisHistoryStatus;
  createdAt: string;
  snapshot: {
    title: string;
    summary: string;
    organizedItems: Array<{ title: string; body: string }>;
  };
  currentTextVersion: number;
}

export type RecordHistorySnapshot =
  | OriginalRecordHistorySnapshot
  | OrganizationRecordHistorySnapshot;

export type AnalysisHistoryStatus =
  | "GENERATED"
  | "ACTIVE"
  | "SUPERSEDED"
  | "DISCARDED"
  | "STALE";

interface ListRecordsResponse {
  items: RecordCard[];
  page: { nextCursor: string | null };
}

export interface RecordPage {
  items: RecordCard[];
  nextCursor: string | null;
}

interface ListUserTagsResponse {
  items: UserTagListItem[];
  page: { nextCursor: string | null };
}

interface ListTagsResponse {
  items: TagListItem[];
  page: { nextCursor: string | null };
}

interface TagMutationResponse {
  tag: TagListItem;
}

interface TagMergeResponse {
  merge: {
    id: string;
    sourceTags: TagListItem[];
    targetTag: TagListItem;
  };
}

interface TagRecordsResponse {
  tag: TagChip;
  items: RecordCard[];
  page: { nextCursor: string | null };
}

interface CreateRecordResponse {
  record: RecordCard;
  task: null;
}

interface OrganizeRecordResponse {
  task: AiTask;
}

interface RecordMutationResponse {
  record: RecordCard;
}

interface RecordHistoryResponse {
  items: RecordHistoryEntry[];
  page: { nextCursor: string | null };
}

export interface SearchMatch {
  reason: "knowledge_point" | "original_text" | "semantic";
  snippets: Array<{
    text: string;
    highlights: Array<{ start: number; end: number }>;
  }>;
  source: {
    id: string;
    type: "fragment" | "knowledge_point" | "overview";
  };
  visibility: "current" | "pending_review";
}

export interface SearchResult {
  record: RecordCard;
  match: SearchMatch;
  otherMatches: SearchMatch[];
}

interface SearchResponse {
  items: SearchResult[];
  page: { nextCursor: string | null };
}

export interface SearchPage {
  items: SearchResult[];
  nextCursor: string | null;
}

export interface SearchHealth {
  keyword: { status: "ready" };
  semantic: {
    configurationVersion: number;
    failedDocuments: number;
    model: string;
    readyDocuments: number;
    status: "building" | "paused" | "ready";
    totalDocuments: number;
  };
}

export interface ActiveModelEndpoint {
  baseUrl: string;
  model: string;
  credential: "configured" | "invalid";
}

export interface DraftModelEndpoint extends ActiveModelEndpoint {
  testStatus: "not_tested" | "passed";
}

export interface ModelConfigurationState {
  active: null | {
    version: number;
    text: ActiveModelEndpoint;
    embedding: ActiveModelEndpoint;
  };
  draft: null | {
    version: number;
    text: DraftModelEndpoint;
    embedding: DraftModelEndpoint;
  };
  canActivate: boolean;
}

export interface ConceptSummary {
  activeMembershipCount: number;
  archivedAt: string | null;
  createdAt: string;
  description: string;
  id: string;
  lifecycle: "active" | "archived";
  name: string;
  reviewMembershipCount: number;
  revisionNumber: number;
  updatedAt: string;
}

export interface ConceptSource {
  body: string;
  id: string;
  recordId: string;
  recordTitle: string;
  title: string;
}

export interface ConceptDetail {
  activity: Array<{
    kind:
      | "archived"
      | "created"
      | "member_added"
      | "member_removed"
      | "member_restored"
      | "restored"
      | "updated";
    membershipId: string | null;
    occurredAt: string;
    revisionId: string | null;
    sequenceNumber: number;
  }>;
  concept: Omit<
    ConceptSummary,
    "activeMembershipCount" | "reviewMembershipCount"
  >;
  memberships: Array<{
    createdAt: string;
    id: string;
    needsReview: boolean;
    origin: "user";
    point: ConceptSource & { current: boolean };
    removedAt: string | null;
    status: "active" | "removed";
  }>;
  revisions: Array<{
    createdAt: string;
    description: string;
    id: string;
    name: string;
    revisionNumber: number;
  }>;
}

export async function listConcepts(options: {
  archive?: "active" | "archived" | "all";
  q?: string;
  signal?: AbortSignal;
} = {}): Promise<ConceptSummary[]> {
  const search = new URLSearchParams();

  if (options.archive) {
    search.set("archive", options.archive);
  }

  if (options.q) {
    search.set("q", options.q);
  }

  const response = await fetch(
    `/api/v1/concepts${search.size ? `?${search.toString()}` : ""}`,
    options.signal ? { signal: options.signal } : undefined,
  );
  const body = await parseConceptResponse<{ items: ConceptSummary[] }>(response);

  return body.items;
}

export async function listConceptSources(
  query = "",
  signal?: AbortSignal,
): Promise<ConceptSource[]> {
  const search = new URLSearchParams();

  if (query) {
    search.set("q", query);
  }

  const response = await fetch(
    `/api/v1/concept-sources${search.size ? `?${search.toString()}` : ""}`,
    signal ? { signal } : undefined,
  );
  const body = await parseConceptResponse<{ items: ConceptSource[] }>(response);

  return body.items;
}

export async function getConceptDetail(id: string): Promise<ConceptDetail> {
  const response = await fetch(`/api/v1/concepts/${encodeURIComponent(id)}`);
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function createConcept(input: {
  description: string;
  knowledgePointIds: string[];
  name: string;
}): Promise<ConceptDetail> {
  const response = await fetch("/api/v1/concepts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function updateConcept(
  id: string,
  input: { description: string; name: string },
): Promise<ConceptDetail> {
  const response = await fetch(`/api/v1/concepts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function addConceptMembership(
  conceptId: string,
  knowledgePointId: string,
): Promise<ConceptDetail> {
  const response = await fetch(
    `/api/v1/concepts/${encodeURIComponent(conceptId)}/memberships`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgePointId }),
    },
  );
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function removeConceptMembership(
  conceptId: string,
  membershipId: string,
): Promise<ConceptDetail> {
  const response = await fetch(
    `/api/v1/concepts/${encodeURIComponent(conceptId)}/memberships/${encodeURIComponent(membershipId)}`,
    { method: "DELETE" },
  );
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function restoreConceptMembership(
  conceptId: string,
  membershipId: string,
): Promise<ConceptDetail> {
  const response = await fetch(
    `/api/v1/concepts/${encodeURIComponent(conceptId)}/memberships/${encodeURIComponent(membershipId)}/restore`,
    { method: "POST" },
  );
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function setConceptArchived(
  conceptId: string,
  archived: boolean,
): Promise<ConceptDetail> {
  const response = await fetch(
    `/api/v1/concepts/${encodeURIComponent(conceptId)}/${archived ? "archive" : "restore"}`,
    { method: "POST" },
  );
  const body = await parseConceptResponse<{ detail: ConceptDetail }>(response);

  return body.detail;
}

export async function listRecords(options: {
  archive?: "active" | "archived" | "all";
  cursor?: string;
  limit?: number;
  processing?: "saved" | "processing" | "processed" | "failed";
  q?: string;
  signal?: AbortSignal;
  sort?: "updated_desc" | "updated_asc";
  tagIds?: string[];
} = {}): Promise<RecordPage> {
  const search = new URLSearchParams();

  if (options.archive) {
    search.set("archive", options.archive);
  }

  if (options.cursor) {
    search.set("cursor", options.cursor);
  }

  if (options.limit) {
    search.set("limit", String(options.limit));
  }

  if (options.processing) {
    search.set("processing", options.processing);
  }

  if (options.q) {
    search.set("q", options.q);
  }

  if (options.sort) {
    search.set("sort", options.sort);
  }

  for (const tagId of options.tagIds ?? []) {
    search.append("tag", tagId);
  }

  const response = await fetch(
    `/api/v1/records${search.size > 0 ? `?${search.toString()}` : ""}`,
    options.signal ? { signal: options.signal } : undefined,
  );
  const body = await parseResponse<ListRecordsResponse>(response);

  return { items: body.items, nextCursor: body.page.nextCursor };
}

export async function getRecordDetail(
  id: string,
  signal?: AbortSignal,
): Promise<RecordDetail> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(id)}`,
    signal ? { signal } : undefined,
  );

  return parseResponse<RecordDetail>(response);
}

export async function putRecordOverviewCorrection(
  recordId: string,
  correction: { title: string; summary: string },
): Promise<RecordDetail["presentation"]> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/overview-correction`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(correction),
    },
  );
  const body = await parseResponse<{
    presentation: RecordDetail["presentation"];
  }>(response);

  return body.presentation;
}

export async function deleteRecordOverviewCorrection(
  recordId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/overview-correction`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    throw new Error(`请求失败（${response.status}）`);
  }
}

export async function getOrganizedItemEvidence(
  recordId: string,
  itemId: string,
): Promise<EvidenceSpan[]> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organized-items/${encodeURIComponent(itemId)}/evidence`,
  );
  const body = await parseResponse<{ items: EvidenceSpan[] }>(response);

  return body.items;
}

export async function putOrganizedItemCorrection(
  recordId: string,
  itemId: string,
  correction: { title: string; body: string },
): Promise<OrganizedItem> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organized-items/${encodeURIComponent(itemId)}/correction`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(correction),
    },
  );
  const body = await parseResponse<{ item: OrganizedItem }>(response);

  return body.item;
}

export async function deleteOrganizedItemCorrection(
  recordId: string,
  itemId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organized-items/${encodeURIComponent(itemId)}/correction`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    throw new Error(`请求失败（${response.status}）`);
  }
}

export async function putOrganizedItemInclusion(
  recordId: string,
  itemId: string,
  status: "included" | "excluded",
): Promise<OrganizedItem> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organized-items/${encodeURIComponent(itemId)}/inclusion`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  const body = await parseResponse<{ item: OrganizedItem }>(response);

  return body.item;
}

export async function getReviewQueue(): Promise<ReviewQueueItem[]> {
  const response = await fetch("/api/v1/review-queue");
  const body = await parseResponse<{
    items: ReviewQueueItem[];
    page: { nextCursor: string | null };
  }>(response);

  return body.items;
}

export async function getTagField(): Promise<TagFieldItem[]> {
  const response = await fetch("/api/v1/tag-field");
  const body = await parseResponse<{ items: TagFieldItem[] }>(response);

  return body.items;
}

export async function decideReviewItem(
  recordId: string,
  itemId: string,
  decision: "confirm" | "reject",
): Promise<{ id: string; publicationStatus: "CONFIRMED" | "REJECTED" }> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organized-items/${encodeURIComponent(itemId)}/review-decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  const body = await parseResponse<{
    item: {
      id: string;
      publicationStatus: "CONFIRMED" | "REJECTED";
    };
  }>(response);

  return body.item;
}

export async function getRecordHistory(
  recordId: string,
): Promise<RecordHistoryEntry[]> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/history`,
  );
  const body = await parseResponse<RecordHistoryResponse>(response);

  return body.items;
}

export async function getRecordHistoryEntry(
  recordId: string,
  entryId: string,
): Promise<RecordHistorySnapshot> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/history/${encodeURIComponent(entryId)}`,
  );

  return parseResponse<RecordHistorySnapshot>(response);
}

export async function listUserTags(
  query: string,
  signal?: AbortSignal,
): Promise<UserTagListItem[]> {
  const search = new URLSearchParams({
    approval: "user_approved",
    q: query,
  });
  const response = await fetch(
    `/api/v1/tags?${search.toString()}`,
    signal ? { signal } : undefined,
  );
  const body = await parseResponse<ListUserTagsResponse>(response);

  return body.items;
}

export async function listTags(options: {
  approval: "candidate" | "user_approved";
  query: string;
  signal?: AbortSignal;
  sort: "name_asc" | "name_desc" | "record_count_desc";
}): Promise<TagListItem[]> {
  const search = new URLSearchParams({
    approval: options.approval,
    q: options.query,
    sort: options.sort,
  });
  const response = await fetch(`/api/v1/tags?${search.toString()}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await parseTagResponse<ListTagsResponse>(response);

  return body.items;
}

export async function createTag(name: string): Promise<TagListItem> {
  const response = await fetch("/api/v1/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await parseTagResponse<TagMutationResponse>(response);

  return body.tag;
}

export async function getTagDetail(tagId: string): Promise<TagDetail> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}`,
  );

  return parseTagResponse<TagDetail>(response);
}

export async function createTagAlias(
  tagId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}/aliases`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  const body = await parseTagResponse<{
    alias: { id: string; name: string };
  }>(response);

  return body.alias;
}

export async function deleteTagAlias(
  tagId: string,
  aliasId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}` +
      `/aliases/${encodeURIComponent(aliasId)}`,
    { method: "DELETE" },
  );

  await ensureTagMutation(response);
}

export async function mergeTags(
  targetTagId: string,
  sourceTagIds: string[],
): Promise<TagMergeResponse["merge"]> {
  const response = await fetch("/api/v1/tag-merges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetTagId, sourceTagIds }),
  });
  const body = await parseTagResponse<TagMergeResponse>(response);

  return body.merge;
}

export async function undoTagMerge(mergeId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/tag-merges/${encodeURIComponent(mergeId)}`,
    { method: "DELETE" },
  );

  await ensureTagMutation(response);
}

export async function updateTag(
  tagId: string,
  input:
    | { name: string }
    | { approvalStatus: "archived" | "user_approved" },
): Promise<TagListItem> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = await parseTagResponse<TagMutationResponse>(response);

  return body.tag;
}

export async function approveCandidateTag(tagId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}/approve`,
    { method: "POST" },
  );

  await parseTagResponse(response);
}

export async function deleteCandidateTag(tagId: string): Promise<void> {
  const response = await fetch(`/api/v1/tags/${encodeURIComponent(tagId)}`, {
    method: "DELETE",
  });

  await ensureTagMutation(response);
}

export async function deleteCandidateTags(tagIds: string[]): Promise<number> {
  const response = await fetch("/api/v1/tags", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: tagIds }),
  });
  const body = await parseTagResponse<{ deletedCount: number }>(response);

  return body.deletedCount;
}

export async function putTagKnowledgePointVisibility(
  tagId: string,
  recordId: string,
  itemId: string,
  status: "active" | "suppressed",
): Promise<void> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}` +
      `/records/${encodeURIComponent(recordId)}` +
      `/items/${encodeURIComponent(itemId)}/visibility`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );

  await ensureTagMutation(response);
}

export async function scanDuplicateSuggestions(): Promise<DuplicateScanResult> {
  const response = await fetch("/api/v1/duplicate-suggestions/scan", {
    method: "POST",
  });
  const body = await parseTagResponse<{ scan: DuplicateScanResult }>(response);

  return body.scan;
}

export async function listDuplicateSuggestions(
  status: "pending" | "resolved",
): Promise<DuplicateSuggestion[]> {
  const response = await fetch(
    `/api/v1/duplicate-suggestions?status=${status}`,
  );
  const body = await parseTagResponse<{ items: DuplicateSuggestion[] }>(response);

  return body.items;
}

export async function acceptDuplicateSuggestion(
  suggestionId: string,
  primarySourceId: string,
): Promise<DuplicateSuggestion> {
  const response = await fetch(
    `/api/v1/duplicate-suggestions/${encodeURIComponent(suggestionId)}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primarySourceId }),
    },
  );
  const body = await parseTagResponse<{ suggestion: DuplicateSuggestion }>(
    response,
  );

  return body.suggestion;
}

export async function rejectDuplicateSuggestion(
  suggestionId: string,
): Promise<DuplicateSuggestion> {
  const response = await fetch(
    `/api/v1/duplicate-suggestions/${encodeURIComponent(suggestionId)}/reject`,
    { method: "POST" },
  );
  const body = await parseTagResponse<{ suggestion: DuplicateSuggestion }>(
    response,
  );

  return body.suggestion;
}

export async function undoDuplicateConsolidation(
  suggestionId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/duplicate-suggestions/${encodeURIComponent(suggestionId)}/consolidation`,
    { method: "DELETE" },
  );

  await ensureTagMutation(response);
}

export async function scanRelationSuggestions(): Promise<{
  alreadyReviewedPairs: number;
  embeddingStatus: "building" | "ready";
  failedPairs: number;
  pendingSuggestions: number;
  recalledPairs: number;
  skippedPairs: number;
  suggestedRelations: number;
}> {
  const response = await fetch("/api/v1/relation-suggestions/scan", {
    method: "POST",
  });
  const body = await parseTagResponse<{
    scan: {
      alreadyReviewedPairs: number;
      embeddingStatus: "building" | "ready";
      failedPairs: number;
      pendingSuggestions: number;
      recalledPairs: number;
      skippedPairs: number;
      suggestedRelations: number;
    };
  }>(response);

  return body.scan;
}

export async function listRelationSuggestions(
  status: "pending" | "resolved",
): Promise<RelationSuggestion[]> {
  const response = await fetch(
    `/api/v1/relation-suggestions?status=${status}`,
  );
  const body = await parseTagResponse<{ items: RelationSuggestion[] }>(response);

  return body.items;
}

export async function confirmRelationSuggestion(
  suggestionId: string,
  input: { description: string; type: KnowledgeRelationType },
): Promise<RelationSuggestion> {
  const response = await fetch(
    `/api/v1/relation-suggestions/${encodeURIComponent(suggestionId)}/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = await parseTagResponse<{ suggestion: RelationSuggestion }>(
    response,
  );

  return body.suggestion;
}

export async function rejectRelationSuggestion(
  suggestionId: string,
): Promise<RelationSuggestion> {
  const response = await fetch(
    `/api/v1/relation-suggestions/${encodeURIComponent(suggestionId)}/reject`,
    { method: "POST" },
  );
  const body = await parseTagResponse<{ suggestion: RelationSuggestion }>(
    response,
  );

  return body.suggestion;
}

export async function removeKnowledgeRelation(relationId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/knowledge-relations/${encodeURIComponent(relationId)}`,
    { method: "DELETE" },
  );

  await ensureTagMutation(response);
}

export async function listCoverageSources(
  query: string,
  signal?: AbortSignal,
): Promise<CoverageSource[]> {
  const search = new URLSearchParams({ q: query });
  const response = await fetch(
    `/api/v1/coverage-sources?${search.toString()}`,
    signal ? { signal } : undefined,
  );
  const body = await parseTagResponse<{ items: CoverageSource[] }>(response);

  return body.items;
}

export async function createCoverageAnalysis(input: {
  recordIds: string[];
  topic: string;
}): Promise<CoverageAnalysis> {
  const response = await fetch("/api/v1/coverage-analyses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await parseTagResponse<{ analysis: CoverageAnalysis }>(response);

  return body.analysis;
}

export async function retryCoverageAnalysis(
  analysisId: string,
): Promise<CoverageAnalysis> {
  const response = await fetch(
    `/api/v1/coverage-analyses/${encodeURIComponent(analysisId)}/retry`,
    { method: "POST" },
  );
  const body = await parseTagResponse<{ analysis: CoverageAnalysis }>(response);

  return body.analysis;
}

export async function listCoverageAnalyses(): Promise<CoverageAnalysis[]> {
  const response = await fetch("/api/v1/coverage-analyses");
  const body = await parseTagResponse<{ items: CoverageAnalysis[] }>(response);

  return body.items;
}

export async function listTagRecords(tagId: string): Promise<RecordCard[]> {
  const response = await fetch(
    `/api/v1/tags/${encodeURIComponent(tagId)}/records`,
  );
  const body = await parseResponse<TagRecordsResponse>(response);

  return body.items;
}

export async function searchRecords(options: {
  cursor?: string;
  limit: number;
  query: string;
  scope: "current" | "include_review";
  signal?: AbortSignal;
  tagIds: string[];
}): Promise<SearchPage> {
  const search = new URLSearchParams();

  if (options.cursor) {
    search.set("cursor", options.cursor);
  }

  search.set("limit", String(options.limit));

  if (options.query) {
    search.set("q", options.query);
  }

  if (options.scope === "include_review") {
    search.set("scope", options.scope);
  }

  for (const tagId of options.tagIds) {
    search.append("tag", tagId);
  }
  const response = await fetch(`/api/v1/search?${search.toString()}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await parseResponse<SearchResponse>(response);

  return {
    items: body.items,
    nextCursor: body.page.nextCursor,
  };
}

export async function getSearchHealth(
  signal?: AbortSignal,
): Promise<SearchHealth> {
  const response = await fetch("/api/v1/search-health", {
    ...(signal ? { signal } : {}),
  });

  return parseResponse<SearchHealth>(response);
}

export async function getModelConfiguration(): Promise<ModelConfigurationState> {
  const response = await fetch("/api/v1/model-config/draft");

  return parseResponse<ModelConfigurationState>(response);
}

export async function saveModelConfigurationDraft(input: {
  text: { baseUrl: string; model: string; apiKey?: string };
  embedding: { baseUrl: string; model: string; apiKey?: string };
}): Promise<ModelConfigurationState> {
  const response = await fetch("/api/v1/model-config/draft", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  return parseResponse<ModelConfigurationState>(response);
}

export async function testModelConfigurationEndpoint(
  kind: "text" | "embedding",
): Promise<void> {
  const response = await fetch(`/api/v1/model-config/draft/tests/${kind}`, {
    method: "POST",
  });

  await parseResponse(response);
}

export async function activateModelConfiguration(): Promise<void> {
  const response = await fetch("/api/v1/model-config/draft/activate", {
    method: "POST",
  });

  await parseResponse(response);
}

export async function createRecord(input: {
  text: string;
  tags: RecordTagSelection[];
}): Promise<RecordCard> {
  const response = await fetch("/api/v1/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: input.text,
      myTags: input.tags.map((tag) =>
        typeof tag === "string" ? { name: tag } : { id: tag.id },
      ),
      processing: "save_only",
    }),
  });
  const body = await parseResponse<CreateRecordResponse>(response);

  return body.record;
}

export async function organizeRecord(
  recordId: string,
  handling: "automatic" | "review",
): Promise<AiTask> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handling }),
    },
  );
  const body = await parseResponse<OrganizeRecordResponse>(response);

  return body.task;
}

export async function adoptOrganizationCandidate(
  recordId: string,
  candidateId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organization-candidates/${encodeURIComponent(candidateId)}/adopt`,
    { method: "POST" },
  );

  await parseResponse(response);
}

export async function discardOrganizationCandidate(
  recordId: string,
  candidateId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/organization-candidates/${encodeURIComponent(candidateId)}/discard`,
    { method: "POST" },
  );

  await parseResponse(response);
}

export async function updateRecord(
  recordId: string,
  input: { text: string; tags: RecordTagSelection[] },
): Promise<RecordCard> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        myTags: input.tags.map((tag) =>
          typeof tag === "string" ? { name: tag } : { id: tag.id },
        ),
        processing: "save_only",
      }),
    },
  );
  const body = await parseResponse<CreateRecordResponse>(response);

  return body.record;
}

export async function archiveRecord(recordId: string): Promise<RecordCard> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/archive`,
    { method: "POST" },
  );
  const body = await parseResponse<RecordMutationResponse>(response);

  return body.record;
}

export async function restoreRecord(recordId: string): Promise<RecordCard> {
  const response = await fetch(
    `/api/v1/records/${encodeURIComponent(recordId)}/restore`,
    { method: "POST" },
  );
  const body = await parseResponse<RecordMutationResponse>(response);

  return body.record;
}

export async function deleteRecord(recordId: string): Promise<void> {
  const response = await fetch(`/api/v1/records/${encodeURIComponent(recordId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`请求失败（${response.status}）`);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`请求失败（${response.status}）`);
  }

  return (await response.json()) as T;
}

async function parseTagResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await tagErrorMessage(response));
  }

  return (await response.json()) as T;
}

async function parseConceptResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await tagErrorMessage(response));
  }

  return (await response.json()) as T;
}

async function ensureTagMutation(response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(await tagErrorMessage(response));
  }
}

async function tagErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown } | string;
    };

    if (
      body.error &&
      typeof body.error === "object" &&
      typeof body.error.message === "string"
    ) {
      return body.error.message;
    }
  } catch {
    // Fall back to the HTTP status when the server has no JSON error body.
  }

  return `请求失败（${response.status}）`;
}

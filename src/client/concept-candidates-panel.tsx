import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  acceptConceptCandidate,
  listConceptCandidateScans,
  rejectConceptCandidate,
  retryConceptCandidateScan,
  runFullConceptDiscovery,
  type ConceptCandidateScan,
} from "./api.js";
import "./concept-candidates-panel.css";

const REFRESH_INTERVAL_MS = 1_000;

export function ConceptCandidatesPanel({
  initialScanId,
  onAccepted,
  onSelectScan,
}: {
  initialScanId: string;
  onAccepted: () => void;
  onSelectScan: (id: string) => void;
}) {
  const [scans, setScans] = useState<ConceptCandidateScan[]>([]);
  const [selectedId, setSelectedId] = useState(initialScanId);
  const [loading, setLoading] = useState(true);
  const [followingFullDiscovery, setFollowingFullDiscovery] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const items = await listConceptCandidateScans("all", signal);

    setScans(items);
    setSelectedId((current) => {
      if (current && items.some((item) => item.id === current)) {
        return current;
      }

      return items[0]?.id ?? "";
    });
    return items;
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    void refresh(controller.signal)
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) {
          setError(messageFrom(caught, "Concept Candidate 暂时无法载入。"));
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (initialScanId) {
      setSelectedId(initialScanId);
    }
  }, [initialScanId]);

  const processing = scans.some(
    (scan) => scan.status === "queued" || scan.status === "running",
  );

  useEffect(() => {
    if (!processing && !followingFullDiscovery) {
      return;
    }

    const controller = new AbortController();
    const interval = window.setInterval(() => {
      void refresh(controller.signal).catch(() => undefined);
    }, REFRESH_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [followingFullDiscovery, processing, refresh]);

  useEffect(() => {
    if (!followingFullDiscovery) {
      return;
    }

    const timeout = window.setTimeout(
      () => setFollowingFullDiscovery(false),
      30_000,
    );

    return () => window.clearTimeout(timeout);
  }, [followingFullDiscovery]);

  const selected = scans.find((scan) => scan.id === selectedId) ?? null;

  function selectScan(id: string) {
    setSelectedId(id);
    setError("");
    setNotice("");
    onSelectScan(id);
  }

  async function retry(scan: ConceptCandidateScan) {
    setBusy(scan.id);
    setError("");

    try {
      const next = await retryConceptCandidateScan(scan.id);

      replaceScan(setScans, next);
      setNotice("扫描已重新排队；仍使用第一次冻结的输入快照。");
    } catch (caught) {
      setError(messageFrom(caught, "扫描暂时无法重试。"));
    } finally {
      setBusy("");
    }
  }

  async function discoverAll() {
    setBusy("full-discovery");
    setError("");
    setNotice("");

    try {
      const result = await runFullConceptDiscovery();

      if (result.enqueuedCount === 0) {
        setFollowingFullDiscovery(false);
        setNotice(
          `全部 ${result.coveredCount} 份生效分析都已覆盖，没有重复登记。`,
        );
      } else {
        setFollowingFullDiscovery(true);
        setNotice(
          `已排队或恢复 ${result.enqueuedCount} 份生效分析，另有 ` +
            `${result.coveredCount} 份已覆盖；系统会按顺序生成待确认候选。`,
        );
      }

      await refresh();
    } catch (caught) {
      setError(messageFrom(caught, "全量 Concept 发现暂时无法启动。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="candidate-workbench">
      <section
        aria-label="全量 Concept 发现"
        className="candidate-discovery-command"
      >
        <div>
          <strong>全量发现历史知识</strong>
          <p>只生成待确认候选，不直接创建 Concept，无需选择范围。</p>
        </div>
        <button
          className="secondary-button"
          disabled={busy === "full-discovery"}
          onClick={() => void discoverAll()}
          type="button"
        >
          {busy === "full-discovery" ? "正在登记…" : "全量发现历史知识"}
        </button>
      </section>

      <aside aria-label="Concept Candidate 扫描记录" className="candidate-catalog">
        <header>
          <div>
            <strong>自动发现</strong>
            <span>{loading ? "正在载入…" : `${scans.length} 次知识分析`}</span>
          </div>
          <span className="candidate-live-mark">持续监听新增知识</span>
        </header>

        <div className="candidate-catalog-list">
          {scans.map((scan, index) => (
            <button
              aria-pressed={selectedId === scan.id}
              className="candidate-catalog-entry"
              data-selected={selectedId === scan.id}
              key={scan.id}
              onClick={() => selectScan(scan.id)}
              type="button"
            >
              <span>
                {scan.origin === "automatic" ? "AUTO" : "AI"}
                {String(scans.length - index).padStart(3, "0")}
              </span>
              <strong>{scanTitle(scan)}</strong>
              <small>
                {scanInputSummary(scan)} · {formatDate(scan.createdAt)}
              </small>
              <em data-status={scanDisplayStatus(scan)}>{scanStatusLabel(scan)}</em>
            </button>
          ))}
          {!loading && scans.length === 0 ? (
            <div className="candidate-catalog-empty">
              <strong>还没有 AI 候选</strong>
              <p>新增知识正式生效后，系统会从全库召回关联知识并在这里给出候选。</p>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="candidate-stage">
        {error ? <p className="candidate-feedback error" role="alert">{error}</p> : null}
        {!error && notice ? (
          <p className="candidate-feedback notice" role="status">{notice}</p>
        ) : null}

        {selected ? (
          <CandidateScanDetail
            busy={busy}
            onAccepted={() => {
              onAccepted();
              setNotice("候选已晋级为正式 Concept；AI 原建议和最终选择都已保留。");
              void refresh();
            }}
            onError={setError}
            onNotice={setNotice}
            onReject={(next) => {
              replaceScan(setScans, next);
              setNotice("候选已拒绝；决定已记录，不会自动生成正式 Concept。");
            }}
            onRetry={() => void retry(selected)}
            scan={selected}
            setBusy={setBusy}
          />
        ) : (
          <div className="candidate-stage-empty">
            <span aria-hidden="true">◇</span>
            <strong>候选会自动来到这里</strong>
            <p>仅保存的原文不会进入 Concept 关联；自动采用或人工确认后的知识会触发全局召回。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function CandidateScanDetail({
  busy,
  onAccepted,
  onError,
  onNotice,
  onReject,
  onRetry,
  scan,
  setBusy,
}: {
  busy: string;
  onAccepted: () => void;
  onError: (value: string) => void;
  onNotice: (value: string) => void;
  onReject: (scan: ConceptCandidateScan) => void;
  onRetry: () => void;
  scan: ConceptCandidateScan;
  setBusy: (value: string) => void;
}) {
  const candidate = scan.candidate;
  const [name, setName] = useState(candidate?.name ?? "");
  const [description, setDescription] = useState(candidate?.description ?? "");
  const [members, setMembers] = useState(candidate?.memberIds ?? []);

  useEffect(() => {
    setName(candidate?.confirmedName ?? candidate?.name ?? "");
    setDescription(
      candidate?.confirmedDescription ?? candidate?.description ?? "",
    );
    setMembers(candidate?.memberIds ?? []);
  }, [candidate?.id, candidate?.reviewStatus]);

  async function accept() {
    if (!candidate || !name.trim() || !description.trim() || members.length < 2) {
      onError("请填写名称和描述，并保留至少两个晋级成员。");
      return;
    }

    setBusy("accept");
    onError("");

    try {
      await acceptConceptCandidate(candidate.id, {
        name,
        description,
        knowledgePointIds: members,
      });
      onAccepted();
    } catch (caught) {
      onError(messageFrom(caught, "候选未能晋级，请检查名称和输入状态。"));
    } finally {
      setBusy("");
    }
  }

  async function reject() {
    if (!candidate) {
      return;
    }

    setBusy("reject");
    onError("");

    try {
      onReject(await rejectConceptCandidate(candidate.id));
    } catch (caught) {
      onError(messageFrom(caught, "候选暂时无法拒绝。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="candidate-detail">
      <header>
        <div>
          <div className="candidate-state-line">
            <span data-status={scanDisplayStatus(scan)}>{scanStatusLabel(scan)}</span>
            <span>{scan.origin === "automatic" ? "全局自动召回" : "历史手动扫描"}</span>
            <span>第 {scan.attemptCount} 次尝试</span>
            <span>模型 {scan.model.name}</span>
          </div>
          <h2>{scanTitle(scan)}</h2>
        </div>
        <time>{formatDate(scan.createdAt)}</time>
      </header>

      {scan.stale ? (
        <p className="candidate-stale" role="status">
          输入知识点已变化。这份建议仍可回看，但不能确认或重试；后续知识正式生效时系统会再次自动发现。
        </p>
      ) : null}

      {scan.status === "queued" || scan.status === "running" ? (
        <section className="candidate-processing" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <strong>{scan.status === "queued" ? "等待模型接手" : "正在提炼共同定义"}</strong>
            <p>输入快照已经冻结，可以离开此页；完成后会出现在全局 AI 任务提示中。</p>
          </div>
        </section>
      ) : null}

      {scan.status === "failed" ? (
        <section className="candidate-failure">
          <strong>{scan.failure?.message ?? "扫描失败，模型没有返回可用结果。"}</strong>
          <p>
            {scan.canRetry
              ? "可以按原输入快照重试一次。"
              : "本次扫描不能再次重试；后续知识生效时系统会重新自动发现。"}
          </p>
          {scan.canRetry ? (
            <button className="secondary-button" disabled={busy === scan.id} onClick={onRetry} type="button">
              {busy === scan.id ? "正在重试…" : "按原快照重试"}
            </button>
          ) : null}
        </section>
      ) : null}

      {scan.status === "succeeded" && !candidate ? (
        <section className="candidate-no-result">
          <strong>{scan.outcome === "duplicate" ? "已有等价候选" : scan.inputs.length === 1 ? "没有召回到可组合知识" : "召回结果没有形成可靠候选"}</strong>
          <p>{scan.outcomeReason}</p>
        </section>
      ) : null}

      {candidate ? (
        <>
          <section className="candidate-proposal">
            <div className="candidate-proposal-heading">
              <div>
                <span>AI 原建议</span>
                <p>{candidate.reason}</p>
              </div>
              <strong data-review={candidate.reviewStatus}>
                {reviewStatusLabel(candidate.reviewStatus)}
              </strong>
            </div>

            <div className="candidate-fields">
              <label>
                <span>晋级名称</span>
                <input
                  disabled={candidate.reviewStatus !== "pending"}
                  maxLength={120}
                  onChange={(event) => setName(event.currentTarget.value)}
                  value={name}
                />
              </label>
              <label>
                <span>晋级描述</span>
                <textarea
                  disabled={candidate.reviewStatus !== "pending"}
                  maxLength={2_000}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                  rows={4}
                  value={description}
                />
              </label>
            </div>
          </section>

          <section className="candidate-inputs">
            <header>
              <div>
                <h3>新增知识与全局召回</h3>
                <p>系统冻结本次新增知识和召回依据；你只需调整最终晋级成员。</p>
              </div>
              <span>{members.length} 个拟晋级成员</span>
            </header>

            <div className="candidate-input-grid">
              {scan.inputs.map((input, index) => {
                const checked = members.includes(input.id);
                const suggested = candidate.memberIds.includes(input.id);

                return (
                  <article data-selected={checked} key={input.id}>
                    <header>
                      <label>
                        <input
                          aria-label={`晋级成员：${input.title}`}
                          checked={checked}
                          disabled={candidate.reviewStatus !== "pending" || !candidate.canConfirm}
                          onChange={(event) => {
                            const nextChecked = event.currentTarget.checked;

                            setMembers((current) =>
                              nextChecked
                                ? [...current, input.id]
                                : current.filter((id) => id !== input.id),
                            )
                          }}
                          type="checkbox"
                        />
                        <span>K{String(index + 1).padStart(2, "0")}</span>
                      </label>
                      {input.seed ? (
                        <em>本次新增知识</em>
                      ) : suggested ? (
                        <em>AI 建议成员</em>
                      ) : (
                        <em>全局召回</em>
                      )}
                    </header>
                    <h4>{input.title}</h4>
                    <p>{input.body}</p>
                    <Link to={`/records/${input.recordId}`}>来源：{input.recordTitle}</Link>
                    <details>
                      <summary>{input.evidence.length} 条冻结证据</summary>
                      {input.evidence.map((evidence) => (
                        <blockquote key={evidence.id}>{evidence.quote}</blockquote>
                      ))}
                    </details>
                  </article>
                );
              })}
            </div>
          </section>

          {candidate.reviewStatus === "pending" ? (
            <footer className="candidate-decision-bar">
              <button
                className="candidate-reject-button"
                disabled={busy === "reject"}
                onClick={() => void reject()}
                type="button"
              >
                {busy === "reject" ? "正在记录…" : "拒绝候选"}
              </button>
              <button
                className="secondary-button"
                onClick={() => onNotice("候选会继续保留在待处理中，可以稍后回来决定。")}
                type="button"
              >
                稍后处理
              </button>
              <button
                className="primary-button"
                disabled={!candidate.canConfirm || members.length < 2 || busy === "accept"}
                onClick={() => void accept()}
                type="button"
              >
                {busy === "accept" ? "正在晋级…" : "确认并创建 Concept"}
              </button>
            </footer>
          ) : null}

          {candidate.reviewStatus === "accepted" && candidate.acceptedConceptId ? (
            <footer className="candidate-final-state">
              <span>已按“{candidate.confirmedName}”晋级，最终成员选择已固定。</span>
              <Link to={`/concepts?concept=${candidate.acceptedConceptId}`}>打开正式 Concept</Link>
            </footer>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function replaceScan(
  setScans: React.Dispatch<React.SetStateAction<ConceptCandidateScan[]>>,
  scan: ConceptCandidateScan,
) {
  setScans((current) => [scan, ...current.filter((item) => item.id !== scan.id)]);
}

function scanTitle(scan: ConceptCandidateScan): string {
  if (scan.candidate) {
    return scan.candidate.confirmedName ?? scan.candidate.name;
  }

  return scan.inputs.slice(0, 2).map((input) => input.title).join(" · ");
}

function scanInputSummary(scan: ConceptCandidateScan): string {
  const seeds = scan.inputs.filter(({ seed }) => seed).length;

  if (scan.origin === "manual") {
    return `${scan.inputs.length} 个历史扫描知识点`;
  }

  return `${seeds} 个新增 · ${scan.inputs.length - seeds} 个召回`;
}

function scanDisplayStatus(scan: ConceptCandidateScan): string {
  if (scan.stale) {
    return "stale";
  }

  if (scan.candidate?.reviewStatus === "pending") {
    return "review";
  }

  return scan.status;
}

function scanStatusLabel(scan: ConceptCandidateScan): string {
  if (scan.stale) {
    return "输入已变化";
  }

  if (scan.status === "queued") {
    return "排队中";
  }

  if (scan.status === "running") {
    return "生成中";
  }

  if (scan.status === "failed") {
    return "生成失败";
  }

  if (scan.candidate?.reviewStatus === "pending") {
    return "待人工确认";
  }

  if (scan.candidate?.reviewStatus === "accepted") {
    return "已晋级";
  }

  if (scan.candidate?.reviewStatus === "rejected") {
    return "已拒绝";
  }

  return scan.outcome === "duplicate" ? "等价候选" : "无建议";
}

function reviewStatusLabel(
  status: NonNullable<ConceptCandidateScan["candidate"]>["reviewStatus"],
): string {
  return status === "pending" ? "等待人工确认" : status === "accepted" ? "已晋级" : "已拒绝";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

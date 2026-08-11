import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  acceptConceptCandidate,
  createConceptCandidateScan,
  listConceptCandidateScans,
  listConceptSources,
  rejectConceptCandidate,
  retryConceptCandidateScan,
  type ConceptCandidateScan,
  type ConceptSource,
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
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
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
      setCreating(false);
    }
  }, [initialScanId]);

  const processing = scans.some(
    (scan) => scan.status === "queued" || scan.status === "running",
  );

  useEffect(() => {
    if (!processing) {
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
  }, [processing, refresh]);

  const selected = scans.find((scan) => scan.id === selectedId) ?? null;

  function selectScan(id: string) {
    setSelectedId(id);
    setCreating(false);
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

  return (
    <div className="candidate-workbench">
      <aside aria-label="Concept Candidate 扫描记录" className="candidate-catalog">
        <header>
          <div>
            <strong>AI 候选</strong>
            <span>{loading ? "正在载入…" : `${scans.length} 次扫描`}</span>
          </div>
          <button
            className="primary-button"
            onClick={() => {
              setCreating(true);
              setError("");
              setNotice("");
            }}
            type="button"
          >
            发起扫描
          </button>
        </header>

        <div className="candidate-catalog-list">
          {scans.map((scan, index) => (
            <button
              aria-pressed={!creating && selectedId === scan.id}
              className="candidate-catalog-entry"
              data-selected={!creating && selectedId === scan.id}
              key={scan.id}
              onClick={() => selectScan(scan.id)}
              type="button"
            >
              <span>AI{String(scans.length - index).padStart(3, "0")}</span>
              <strong>{scanTitle(scan)}</strong>
              <small>{scan.inputs.length} 个冻结知识点 · {formatDate(scan.createdAt)}</small>
              <em data-status={scanDisplayStatus(scan)}>{scanStatusLabel(scan)}</em>
            </button>
          ))}
          {!loading && scans.length === 0 ? (
            <div className="candidate-catalog-empty">
              <strong>还没有 AI 候选</strong>
              <p>选择 2–12 个知识点，让 AI 提炼一个可选定义。</p>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="candidate-stage">
        {error ? <p className="candidate-feedback error" role="alert">{error}</p> : null}
        {!error && notice ? (
          <p className="candidate-feedback notice" role="status">{notice}</p>
        ) : null}

        {creating ? (
          <CandidateScanBuilder
            onCancel={() => setCreating(false)}
            onCreated={(scan) => {
              replaceScan(setScans, scan);
              setSelectedId(scan.id);
              setCreating(false);
              setNotice("扫描已进入队列；AI 最多返回一个候选，也可能明确不给建议。");
              onSelectScan(scan.id);
            }}
          />
        ) : selected ? (
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
            <strong>从一组明确的知识点开始</strong>
            <p>AI 只提出候选；正式 Concept 仍由你确认。</p>
            <button className="primary-button" onClick={() => setCreating(true)} type="button">
              选择扫描范围
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function CandidateScanBuilder({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (scan: ConceptCandidateScan) => void;
}) {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<ConceptSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    void listConceptSources(query, controller.signal)
      .then(setSources)
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) {
          setError(messageFrom(caught, "知识点目录暂时无法载入。"));
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [query]);

  async function submit() {
    if (selected.length < 2 || selected.length > 12) {
      setError("请选择 2–12 个知识点作为本次扫描的固定范围。");
      return;
    }

    setBusy(true);
    setError("");

    try {
      onCreated(await createConceptCandidateScan(selected));
    } catch (caught) {
      setError(messageFrom(caught, "扫描未能发起，请检查模型配置和知识点状态。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label="发起 Concept Candidate 扫描"
      className="candidate-builder"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <header>
        <div>
          <span>显式范围 · 单次建议</span>
          <h2>选择这次要一起理解的知识点</h2>
          <p>提交后会冻结标题、正文与证据。AI 最多提出一个候选，不会自动进入正式图册。</p>
        </div>
        <button className="secondary-button" onClick={onCancel} type="button">取消</button>
      </header>

      <label className="candidate-source-search">
        <span className="visually-hidden">筛选扫描知识点</span>
        <input
          aria-label="筛选扫描知识点"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="筛选标题、正文或来源"
          type="search"
          value={query}
        />
        <strong>{selected.length} / 12</strong>
      </label>

      <div className="candidate-source-list">
        {sources.map((source) => {
          const checked = selected.includes(source.id);
          const disabled = !checked && selected.length >= 12;

          return (
            <label data-selected={checked} key={source.id}>
              <input
                aria-label={`扫描知识点：${source.title}`}
                checked={checked}
                disabled={disabled}
                onChange={(event) => {
                  const nextChecked = event.currentTarget.checked;

                  setSelected((current) =>
                    nextChecked
                      ? [...current, source.id]
                      : current.filter((id) => id !== source.id),
                  );
                }}
                type="checkbox"
              />
              <span>
                <strong>{source.title}</strong>
                <small>{source.recordTitle}</small>
              </span>
              <p>{source.body}</p>
            </label>
          );
        })}
        {loading ? <p className="candidate-source-empty">正在检索知识点…</p> : null}
        {!loading && sources.length === 0 ? (
          <p className="candidate-source-empty">没有匹配的当前知识点。</p>
        ) : null}
      </div>

      {error ? <p className="candidate-inline-error" role="alert">{error}</p> : null}

      <footer>
        <span>至少选择 2 个；选择范围越聚焦，候选越容易判断。</span>
        <button className="primary-button" disabled={busy || selected.length < 2} type="submit">
          {busy ? "正在冻结输入…" : "生成 AI 候选"}
        </button>
      </footer>
    </form>
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
            <span>第 {scan.attemptCount} 次尝试</span>
            <span>模型 {scan.model.name}</span>
          </div>
          <h2>{scanTitle(scan)}</h2>
        </div>
        <time>{formatDate(scan.createdAt)}</time>
      </header>

      {scan.stale ? (
        <p className="candidate-stale" role="status">
          输入知识点已变化。这份建议仍可回看，但不能确认或重试；请重新选择当前知识点发起扫描。
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
          <p>{scan.canRetry ? "可以按原输入快照重试一次。" : "本次扫描不能再次重试，请重新发起。"}</p>
          {scan.canRetry ? (
            <button className="secondary-button" disabled={busy === scan.id} onClick={onRetry} type="button">
              {busy === scan.id ? "正在重试…" : "按原快照重试"}
            </button>
          ) : null}
        </section>
      ) : null}

      {scan.status === "succeeded" && !candidate ? (
        <section className="candidate-no-result">
          <strong>{scan.outcome === "duplicate" ? "已有等价候选" : "这组输入没有形成可靠候选"}</strong>
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
                <h3>冻结输入与证据</h3>
                <p>可在本次固定范围内调整最终成员；AI 建议的成员已预选。</p>
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
                      {suggested ? <em>AI 建议成员</em> : <em>扫描范围</em>}
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

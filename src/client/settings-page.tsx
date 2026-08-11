/*
 * THESIS: Settings is an operations ledger: explicit snapshots, independent endpoints, no secret theatre.
 * OWN-WORLD: Theme previews lead into either cloud-white berry controls or cold blue-gray archive controls.
 * STORY: The user chooses an appearance, verifies the active model pair, prepares candidates, then manages durable data.
 * FIRST VIEWPORT: 60px navigation, horizontal anchors, two theme choices, then paired model controls and operation rows.
 */
import { useEffect, useRef, useState } from "react";

import { DEFAULT_ANALYSIS_PROMPT } from "../domain/analysis-prompt.js";
import {
  activateModelConfiguration,
  getModelConfiguration,
  saveModelConfigurationDraft,
  testModelConfigurationEndpoint,
  type ActiveModelEndpoint,
  type DraftModelEndpoint,
  type ModelConfigurationState,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import {
  getPreferences,
  updatePreferences,
  type DefaultAiHandling,
} from "./preferences-api.js";
import { useTheme, type AppTheme } from "./theme.js";
import "./settings-page.css";

const DEFAULT_TEXT_ENDPOINT = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
} as const;
const DEFAULT_EMBEDDING_ENDPOINT = {
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "BAAI/bge-m3",
} as const;

export function SettingsPage() {
  const [configuration, setConfiguration] =
    useState<ModelConfigurationState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;

    void getModelConfiguration()
      .then((state) => {
        if (active) {
          setConfiguration(state);
        }
      })
      .catch(() => {
        if (active) {
          setLoadError("模型配置暂时无法载入，请稍后重试。");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  function handleSaved() {
    setNewRecordOpen(false);
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  return (
    <div className="settings-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <main aria-label="设置" className="settings-main">
        <header className="settings-heading">
          <div>
            <p>实例偏好</p>
            <h1>设置</h1>
          </div>
          <nav aria-label="设置分区" className="settings-anchors">
            <a href="#appearance-settings">外观</a>
            <a href="#model-settings">AI 模型</a>
            <a href="#data-settings">数据管理</a>
          </nav>
        </header>

        <AppearanceSettingsPanel />
        {loadError ? <p className="settings-load-error" role="alert">{loadError}</p> : null}
        {!configuration && !loadError ? <p role="status">正在载入设置…</p> : null}
        {configuration ? (
          <>
            <ModelSettingsPanel
              configuration={configuration}
              onConfigurationChange={setConfiguration}
            />
            <DataManagementPanel />
          </>
        ) : null}
      </main>

      <NewRecordDialog
        onClose={() => {
          setNewRecordOpen(false);
          window.requestAnimationFrame(() => newRecordButton.current?.focus());
        }}
        onSaved={handleSaved}
        open={newRecordOpen}
      />
    </div>
  );
}

function AppearanceSettingsPanel() {
  const { setTheme, theme } = useTheme();
  const choices: Array<{
    description: string;
    label: string;
    theme: AppTheme;
  }> = [
    {
      description: "云朵纸白、莓果文字与马卡龙气泡，适合明亮环境。",
      label: "马卡龙气泡",
      theme: "macaron",
    },
    {
      description: "深空首页、神经膜节点与冷调档案内页，保留原始视觉。",
      label: "科幻信号场",
      theme: "scifi",
    },
  ];

  return (
    <section
      aria-label="外观主题"
      className="settings-panel appearance-settings-panel"
      id="appearance-settings"
    >
      <PanelHeading
        eyebrow="界面外观"
        summary="选择会立即应用到全部页面，并保存在当前浏览器中。"
        title="主题"
      />
      <fieldset className="theme-choice-grid">
        <legend className="visually-hidden">选择界面主题</legend>
        {choices.map((choice) => (
          <label className="theme-choice" key={choice.theme}>
            <input
              checked={theme === choice.theme}
              name="appearance-theme"
              onChange={() => setTheme(choice.theme)}
              type="radio"
              value={choice.theme}
            />
            <span
              aria-hidden="true"
              className={`theme-choice-preview ${choice.theme}`}
            >
              <span />
              <span />
              <span />
            </span>
            <span className="theme-choice-copy">
              <strong>{choice.label}</strong>
              <span>{choice.description}</span>
            </span>
            <span className="theme-choice-state">
              {theme === choice.theme ? "当前使用" : "切换"}
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function ModelSettingsPanel({
  configuration,
  onConfigurationChange,
}: {
  configuration: ModelConfigurationState;
  onConfigurationChange: (configuration: ModelConfigurationState) => void;
}) {
  const candidateText =
    configuration.draft?.text ??
    (configuration.active?.text.credential === "invalid"
      ? { ...configuration.active.text, testStatus: "not_tested" as const }
      : {
          ...DEFAULT_TEXT_ENDPOINT,
          credential: "configured" as const,
          testStatus: "not_tested" as const,
        });
  const candidateEmbedding =
    configuration.draft?.embedding ??
    (configuration.active?.embedding.credential === "invalid"
      ? {
          ...configuration.active.embedding,
          testStatus: "not_tested" as const,
        }
      : {
          ...DEFAULT_EMBEDDING_ENDPOINT,
          credential: "configured" as const,
          testStatus: "not_tested" as const,
        });
  const activeCredentialInvalid =
    configuration.active?.text.credential === "invalid" ||
    configuration.active?.embedding.credential === "invalid";
  const hasInvalidCredential =
    activeCredentialInvalid ||
    candidateText.credential === "invalid" ||
    candidateEmbedding.credential === "invalid";
  const [draft, setDraft] = useState(() => ({
    text: {
      baseUrl: candidateText.baseUrl,
      model: candidateText.model,
      apiKey: "",
    },
    embedding: {
      baseUrl: candidateEmbedding.baseUrl,
      model: candidateEmbedding.model,
      apiKey: "",
    },
  }));
  const [busyAction, setBusyAction] = useState<
    "save" | "text" | "embedding" | "activate" | null
  >(null);
  const [actionError, setActionError] = useState("");
  const textDirty =
    draft.text.baseUrl !== candidateText.baseUrl ||
    draft.text.model !== candidateText.model ||
    draft.text.apiKey.length > 0;
  const embeddingDirty =
    draft.embedding.baseUrl !== candidateEmbedding.baseUrl ||
    draft.embedding.model !== candidateEmbedding.model ||
    draft.embedding.apiKey.length > 0;
  const hasUnsavedChanges = textDirty || embeddingDirty;

  function updateDraft(
    kind: "text" | "embedding",
    field: "baseUrl" | "model" | "apiKey",
    value: string,
  ) {
    setDraft((current) => ({
      ...current,
      [kind]: { ...current[kind], [field]: value },
    }));
  }

  async function saveDraft() {
    setActionError("");

    if (
      (candidateText.credential === "invalid" && !draft.text.apiKey) ||
      (candidateEmbedding.credential === "invalid" &&
        !draft.embedding.apiKey)
    ) {
      setActionError("凭据已失效，请重新输入标记端点的 API Key 后再保存。");
      return;
    }

    setBusyAction("save");

    try {
      const saved = await saveModelConfigurationDraft({
        text: {
          baseUrl: draft.text.baseUrl,
          model: draft.text.model,
          ...(draft.text.apiKey ? { apiKey: draft.text.apiKey } : {}),
        },
        embedding: {
          baseUrl: draft.embedding.baseUrl,
          model: draft.embedding.model,
          ...(draft.embedding.apiKey
            ? { apiKey: draft.embedding.apiKey }
            : {}),
        },
      });

      setDraft({
        text: {
          baseUrl: saved.draft?.text.baseUrl ?? draft.text.baseUrl,
          model: saved.draft?.text.model ?? draft.text.model,
          apiKey: "",
        },
        embedding: {
          baseUrl:
            saved.draft?.embedding.baseUrl ?? draft.embedding.baseUrl,
          model: saved.draft?.embedding.model ?? draft.embedding.model,
          apiKey: "",
        },
      });
      onConfigurationChange(saved);
    } catch {
      setActionError("候选配置保存失败，请检查两个端点与凭据。 ");
    } finally {
      setBusyAction(null);
    }
  }

  async function testEndpoint(kind: "text" | "embedding") {
    setBusyAction(kind);
    setActionError("");

    try {
      await testModelConfigurationEndpoint(kind);
      onConfigurationChange(await getModelConfiguration());
    } catch {
      setActionError(`${endpointLabel(kind)}连接测试失败。`);
    } finally {
      setBusyAction(null);
    }
  }

  async function activateDraft() {
    setBusyAction("activate");
    setActionError("");

    try {
      await activateModelConfiguration();
      onConfigurationChange(await getModelConfiguration());
    } catch {
      setActionError("候选配置未能启用，请确认两个端点均已测试通过。");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section aria-label="AI 模型" className="settings-panel" id="model-settings">
      <PanelHeading
        eyebrow="模型配置"
        summary="文本推理与 Embedding 使用各自独立的服务地址、模型和凭据。"
        title="AI 模型"
      />

      <DefaultAiHandlingSetting />
      <AnalysisPromptSetting />

      {hasInvalidCredential ? (
        <p className="settings-credential-warning" role="alert">
          保存的模型凭据已失效，可能是配置加密密钥发生变化。请在候选配置中重新输入标记端点的 API Key，保存并重新测试后启用。
        </p>
      ) : null}

      <div aria-label="当前配置" className="configuration-group" role="group">
        <div className="configuration-group-heading">
          <div>
            <h2>当前配置</h2>
            <p>后台任务实际使用的原子配置快照</p>
          </div>
          <span aria-label="配置状态" role="status">
            {configuration.active
              ? `v${configuration.active.version} · ${activeCredentialInvalid ? "凭据失效" : "已启用"}`
              : "尚未启用"}
          </span>
        </div>
        <div className="model-endpoint-grid">
          <CurrentEndpointGroup
            endpoint={configuration.active?.text ?? null}
            kind="text"
          />
          <CurrentEndpointGroup
            endpoint={configuration.active?.embedding ?? null}
            kind="embedding"
          />
        </div>
      </div>

      <div aria-label="候选配置" className="configuration-group candidate" role="group">
        <div className="configuration-group-heading">
          <div>
            <h2>候选配置</h2>
            <p id="candidate-configuration-help">
              先保存候选配置，再分别测试两个端点；全部通过后才可一次启用
            </p>
          </div>
          <div className="candidate-actions">
            <button
              className="secondary-button"
              disabled={busyAction !== null}
              onClick={() => void saveDraft()}
              type="button"
            >
              {busyAction === "save" ? "保存中…" : "保存候选配置"}
            </button>
            <button
              aria-describedby="candidate-configuration-help"
              className="primary-button"
              disabled={
                !configuration.canActivate ||
                hasUnsavedChanges ||
                busyAction !== null
              }
              onClick={() => void activateDraft()}
              type="button"
            >
              {busyAction === "activate" ? "启用中…" : "启用候选配置"}
            </button>
          </div>
        </div>
        <div className="model-endpoint-grid">
          <CandidateEndpointGroup
            apiKey={draft.text.apiKey}
            baseUrl={draft.text.baseUrl}
            busy={busyAction !== null}
            dirty={textDirty}
            endpoint={candidateText}
            kind="text"
            model={draft.text.model}
            onChange={updateDraft}
            onTest={testEndpoint}
          />
          <CandidateEndpointGroup
            apiKey={draft.embedding.apiKey}
            baseUrl={draft.embedding.baseUrl}
            busy={busyAction !== null}
            dirty={embeddingDirty}
            endpoint={candidateEmbedding}
            kind="embedding"
            model={draft.embedding.model}
            onChange={updateDraft}
            onTest={testEndpoint}
          />
        </div>
        {actionError ? <p className="settings-action-error" role="alert">{actionError}</p> : null}
      </div>
    </section>
  );
}

function DefaultAiHandlingSetting() {
  const [value, setValue] = useState<DefaultAiHandling | null>(null);
  const [status, setStatus] = useState<
    "error" | "loading" | "ready" | "saved" | "saving"
  >("loading");

  useEffect(() => {
    let active = true;

    void getPreferences()
      .then((preferences) => {
        if (active) {
          setValue(preferences.defaultAiHandling);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          setStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function choose(next: DefaultAiHandling) {
    if (!value || next === value || status === "saving") {
      return;
    }

    setStatus("saving");

    try {
      const preferences = await updatePreferences({ defaultAiHandling: next });

      setValue(preferences.defaultAiHandling);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  const disabled = value === null || status === "saving";
  const statusCopy =
    status === "loading"
      ? "正在载入默认值…"
      : status === "saving"
        ? "正在保存…"
        : status === "saved"
          ? "默认值已保存"
          : status === "error"
            ? "默认值暂时无法载入或保存，请重试。"
            : value === "review"
              ? "当前默认：由我确认"
              : "当前默认：自动采用";

  return (
    <div
      aria-labelledby="handling-preference-title"
      className="handling-preference"
      role="group"
    >
      <div className="handling-preference-copy">
        <h3 id="handling-preference-title">新记录默认处理</h3>
        <p id="handling-preference-help">
          每次新建时仍可单独切换；仅保存不受此默认值影响。
        </p>
      </div>
      <div
        aria-describedby="handling-preference-help"
        className="handling-preference-options"
      >
        <label>
          <input
            checked={value === "automatic"}
            disabled={disabled}
            name="default-ai-handling"
            onChange={() => void choose("automatic")}
            type="radio"
          />
          <span>AI 整理并自动采用</span>
        </label>
        <label>
          <input
            checked={value === "review"}
            disabled={disabled}
            name="default-ai-handling"
            onChange={() => void choose("review")}
            type="radio"
          />
          <span>AI 整理后由我确认</span>
        </label>
      </div>
      <output
        aria-label="默认处理状态"
        className={status === "error" ? "is-error" : undefined}
        role={status === "error" ? "alert" : "status"}
      >
        {statusCopy}
      </output>
    </div>
  );
}

function AnalysisPromptSetting() {
  const [draft, setDraft] = useState("");
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "error" | "loading" | "ready" | "saved" | "saving"
  >("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let active = true;

    void getPreferences()
      .then((preferences) => {
        if (active) {
          setDraft(preferences.analysisPrompt);
          setSavedValue(preferences.analysisPrompt);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          setErrorMessage("AI 整理提示词暂时无法载入，请稍后重试。");
          setStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const dirty = savedValue !== null && draft !== savedValue;
  const busy = status === "loading" || status === "saving";
  const statusCopy =
    status === "loading"
      ? "正在载入提示词…"
      : status === "saving"
        ? "正在保存…"
        : status === "saved"
          ? "提示词已保存"
          : status === "error"
            ? errorMessage
            : dirty
              ? "有未保存更改"
              : "当前设置已生效";

  function updateDraft(value: string) {
    setDraft(value);

    if (status === "error" || status === "saved") {
      setErrorMessage("");
      setStatus("ready");
    }
  }

  function restoreDefault() {
    updateDraft(DEFAULT_ANALYSIS_PROMPT);
  }

  async function savePrompt() {
    if (savedValue === null || status === "saving") {
      return;
    }

    if (!draft.trim()) {
      setErrorMessage("AI 整理提示词不能为空。");
      setStatus("error");
      return;
    }

    setErrorMessage("");
    setStatus("saving");

    try {
      const preferences = await updatePreferences({ analysisPrompt: draft });

      setDraft(preferences.analysisPrompt);
      setSavedValue(preferences.analysisPrompt);
      setStatus("saved");
    } catch {
      setErrorMessage("AI 整理提示词保存失败，请重试。");
      setStatus("error");
    }
  }

  return (
    <form
      aria-labelledby="analysis-prompt-title"
      className="configuration-group analysis-prompt-setting"
      onSubmit={(event) => {
        event.preventDefault();
        void savePrompt();
      }}
    >
      <div className="analysis-prompt-heading">
        <div>
          <h3 id="analysis-prompt-title">AI 整理提示词</h3>
          <p>控制标题、摘要、知识点和候选标签的整理规则</p>
        </div>
        <output
          aria-label="提示词设置状态"
          className={status === "error" ? "is-error" : undefined}
          role={status === "error" ? "alert" : "status"}
        >
          {statusCopy}
        </output>
      </div>

      <label className="analysis-prompt-field" htmlFor="analysis-prompt">
        <span>可编辑 Prompt（固定 JSON 结构之前）</span>
        <textarea
          aria-describedby="analysis-prompt-help"
          disabled={savedValue === null || status === "saving"}
          id="analysis-prompt"
          onChange={(event) => updateDraft(event.target.value)}
          rows={7}
          spellCheck={false}
          value={draft}
        />
      </label>

      <div className="analysis-prompt-footer">
        <p id="analysis-prompt-help">
          固定 JSON 输出结构由系统自动追加，不能在设置中修改。更改只影响之后创建的 AI 整理任务。
        </p>
        <div className="analysis-prompt-actions">
          <button
            className="secondary-button"
            disabled={
              busy ||
              savedValue === null ||
              draft === DEFAULT_ANALYSIS_PROMPT
            }
            onClick={restoreDefault}
            type="button"
          >
            恢复默认
          </button>
          <button
            className="primary-button"
            disabled={busy || !dirty || !draft.trim()}
            type="submit"
          >
            {status === "saving" ? "保存中…" : "保存提示词"}
          </button>
        </div>
      </div>
    </form>
  );
}

function CurrentEndpointGroup({
  endpoint,
  kind,
}: {
  endpoint: ActiveModelEndpoint | null;
  kind: "text" | "embedding";
}) {
  const credentialInvalid = endpoint?.credential === "invalid";

  return (
    <section aria-label={endpointLabel(kind)} className="model-endpoint-card current" role="group">
      <EndpointCardHeading
        kind={kind}
        status={credentialInvalid ? "凭据失效" : endpoint ? "已配置" : "待配置"}
      />
      <dl className="current-endpoint-values">
        <div>
          <dt>Base URL</dt>
          <dd aria-label="Base URL">{endpoint?.baseUrl ?? "—"}</dd>
        </div>
        <div>
          <dt>模型标识</dt>
          <dd aria-label="模型标识">{endpoint?.model ?? "—"}</dd>
        </div>
        <div>
          <dt>凭据</dt>
          <dd
            aria-label="凭据状态"
            className={credentialInvalid ? "is-invalid" : undefined}
            role="status"
          >
            {credentialInvalid
              ? "凭据已失效"
              : endpoint
                ? "已保存凭据"
                : "尚未保存"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function CandidateEndpointGroup({
  apiKey,
  baseUrl,
  busy,
  dirty,
  endpoint,
  kind,
  model,
  onChange,
  onTest,
}: {
  apiKey: string;
  baseUrl: string;
  busy: boolean;
  dirty: boolean;
  endpoint: DraftModelEndpoint;
  kind: "text" | "embedding";
  model: string;
  onChange: (
    kind: "text" | "embedding",
    field: "baseUrl" | "model" | "apiKey",
    value: string,
  ) => void;
  onTest: (kind: "text" | "embedding") => Promise<void>;
}) {
  const idPrefix = `candidate-${kind}`;
  const credentialInvalid = endpoint.credential === "invalid";

  return (
    <section aria-label={endpointLabel(kind)} className="model-endpoint-card" role="group">
      <EndpointCardHeading
        kind={kind}
        status={
          credentialInvalid
            ? "凭据失效"
            : dirty
              ? "待保存"
            : endpoint.testStatus === "passed"
              ? "测试通过"
              : "尚未测试"
        }
      />
      <label htmlFor={`${idPrefix}-base-url`}>
        <span>Base URL</span>
        <input
          id={`${idPrefix}-base-url`}
          onChange={(event) => onChange(kind, "baseUrl", event.target.value)}
          type="url"
          value={baseUrl}
        />
      </label>
      <label htmlFor={`${idPrefix}-model`}>
        <span>模型标识</span>
        <input
          id={`${idPrefix}-model`}
          onChange={(event) => onChange(kind, "model", event.target.value)}
          type="text"
          value={model}
        />
      </label>
      <label htmlFor={`${idPrefix}-api-key`}>
        <span>API Key</span>
        <input
          aria-describedby={`${idPrefix}-credential-status`}
          aria-invalid={credentialInvalid}
          autoComplete="new-password"
          id={`${idPrefix}-api-key`}
          onChange={(event) => onChange(kind, "apiKey", event.target.value)}
          placeholder={credentialInvalid ? "请重新输入 API Key" : undefined}
          required={credentialInvalid}
          type="password"
          value={apiKey}
        />
      </label>
      <div className="credential-row">
        <span
          aria-label="凭据状态"
          className={credentialInvalid ? "is-invalid" : undefined}
          id={`${idPrefix}-credential-status`}
          role="status"
        >
          {credentialInvalid ? "凭据已失效，请重新输入" : "已保存凭据"}
        </span>
        <span
          aria-label="连接测试状态"
          id={`${idPrefix}-test-status`}
          role="status"
        >
          {dirty
            ? "有未保存更改"
            : endpoint.testStatus === "passed"
              ? "测试通过"
              : "尚未测试"}
        </span>
        <button
          aria-describedby={`${idPrefix}-test-status`}
          className="secondary-button"
          disabled={busy || credentialInvalid || dirty}
          onClick={() => void onTest(kind)}
          type="button"
        >
          测试连接
        </button>
      </div>
    </section>
  );
}

function EndpointCardHeading({
  kind,
  status,
}: {
  kind: "text" | "embedding";
  status: string;
}) {
  return (
    <header className="endpoint-card-heading">
      <div>
        <span aria-hidden="true" className={`endpoint-glyph ${kind}`} />
        <h3>{endpointLabel(kind)}</h3>
      </div>
      <span>{status}</span>
    </header>
  );
}

function DataManagementPanel() {
  const [exportJob, setExportJob] = useState<PublicExport | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [inspection, setInspection] =
    useState<RestoreInspection | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [searchHealth, setSearchHealth] = useState<SearchHealth | null>(null);
  const [searchError, setSearchError] = useState("");
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const exportAbort = useRef<AbortController | null>(null);
  const restoreAbort = useRef<AbortController | null>(null);
  const searchAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    searchAbort.current = controller;
    void getSearchHealth(controller.signal)
      .then(setSearchHealth)
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setSearchError("搜索健康状态暂时无法读取，请稍后重试。");
        }
      });

    return () => {
      exportAbort.current?.abort();
      restoreAbort.current?.abort();
      searchAbort.current?.abort();
    };
  }, []);

  async function startExport() {
    exportAbort.current?.abort();

    const controller = new AbortController();

    exportAbort.current = controller;
    setExportBusy(true);
    setExportError("");

    try {
      const started = await createExport(controller.signal);

      setExportJob(started);

      const completed = await waitForExport(started, controller.signal);

      setExportJob(completed);

      if (completed.status === "failed") {
        setExportError("完整导出未能生成，请重试。");
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setExportError(errorMessage(error, "完整导出未能生成，请重试。"));
      }
    } finally {
      if (!controller.signal.aborted) {
        setExportBusy(false);
      }
    }
  }

  async function inspectArchive() {
    if (!archive) {
      setRestoreError("请先选择完整导出 ZIP。");
      return;
    }

    restoreAbort.current?.abort();

    const controller = new AbortController();

    restoreAbort.current = controller;
    setInspectionBusy(true);
    setRestoreError("");
    setRestoreResult(null);

    try {
      setInspection(await inspectRestoreArchive(archive, controller.signal));
    } catch (error) {
      if (!isAbortError(error)) {
        setInspection(null);
        setRestoreError(
          errorMessage(error, "恢复包检查失败，请确认文件完整后重试。"),
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setInspectionBusy(false);
      }
    }
  }

  async function restoreArchive() {
    if (!inspection?.canRestore) {
      return;
    }

    restoreAbort.current?.abort();

    const controller = new AbortController();

    restoreAbort.current = controller;
    setRestoreBusy(true);
    setRestoreError("");

    try {
      setRestoreResult(
        await commitRestore(inspection.id, controller.signal),
      );
    } catch (error) {
      if (!isAbortError(error)) {
        setRestoreError(errorMessage(error, "恢复失败，实例数据未发生改变。"));
      }
    } finally {
      if (!controller.signal.aborted) {
        setRestoreBusy(false);
      }
    }
  }

  async function rebuildSearchIndex() {
    searchAbort.current?.abort();

    const controller = new AbortController();

    searchAbort.current = controller;
    setRebuildBusy(true);
    setSearchError("");

    try {
      await requestSearchRebuild(controller.signal);
      setSearchHealth(await getSearchHealth(controller.signal));
    } catch (error) {
      if (!isAbortError(error)) {
        setSearchError(errorMessage(error, "搜索索引重建未能启动，请重试。"));
      }
    } finally {
      if (!controller.signal.aborted) {
        setRebuildBusy(false);
      }
    }
  }

  return (
    <section aria-label="数据管理" className="settings-panel data-panel" id="data-settings">
      <PanelHeading
        eyebrow="数据操作"
        summary="导出不包含模型密钥、日志、Embedding 或可重新生成的缓存。"
        title="数据管理"
      />
      <ul aria-label="数据管理操作" className="data-operation-list">
        <li aria-busy={exportBusy}>
          <div className="data-operation-content">
            <h2>导出全部数据</h2>
            <p>生成同时包含易读 Markdown 与无损 JSON 的完整 ZIP。</p>
            <div className="operation-state-line">
              <span aria-label="导出状态" role="status">
                {exportError || exportStatusText(exportJob, exportBusy)}
              </span>
              {exportJob?.status === "succeeded" && exportJob.completedAt ? (
                <time
                  aria-label="导出完成时间"
                  dateTime={exportJob.completedAt}
                >
                  {formatDateTime(exportJob.completedAt)}
                </time>
              ) : null}
            </div>
          </div>
          <div className="data-operation-actions">
            <button
              className="secondary-button"
              disabled={exportBusy}
              onClick={() => void startExport()}
              type="button"
            >
              {exportBusy ? "正在生成…" : "生成导出包"}
            </button>
            {exportJob?.status === "succeeded" && exportJob.downloadUrl ? (
              <a
                className="secondary-button export-download-link"
                download
                href={exportJob.downloadUrl}
              >
                下载完整 ZIP
              </a>
            ) : null}
          </div>
        </li>

        <li aria-busy={inspectionBusy || restoreBusy}>
          <div className="data-operation-content">
            <h2>恢复到空实例</h2>
            <p>先检查完整 ZIP，仅在当前实例没有领域数据时全量恢复。</p>
            <p aria-label="恢复检查状态" className="operation-status" role="status">
              {restoreStatusText({
                archive,
                inspection,
                inspectionBusy,
                restoreBusy,
                restoreError,
                restoreResult,
              })}
            </p>
          </div>
          <div className="data-operation-actions restore-actions">
            <label className="restore-file-picker">
              <span>选择完整导出 ZIP</span>
              <input
                accept=".zip,application/zip"
                onChange={(event) => {
                  setArchive(event.target.files?.[0] ?? null);
                  setInspection(null);
                  setRestoreError("");
                  setRestoreResult(null);
                }}
                type="file"
              />
            </label>
            <button
              className="secondary-button"
              disabled={!archive || inspectionBusy || restoreBusy}
              onClick={() => void inspectArchive()}
              type="button"
            >
              {inspectionBusy ? "正在检查…" : "检查恢复包"}
            </button>
            <button
              className="primary-button"
              disabled={
                !inspection?.canRestore ||
                restoreBusy ||
                restoreResult !== null
              }
              onClick={() => void restoreArchive()}
              type="button"
            >
              {restoreBusy ? "正在恢复…" : "执行恢复"}
            </button>
          </div>
        </li>

        <li aria-busy={rebuildBusy}>
          <div className="data-operation-content">
            <h2>重建搜索索引</h2>
            <p>重建全文与向量派生数据；记录原文和关键词搜索不受阻塞。</p>
            <div className="operation-state-line search-health-line">
              <span aria-label="关键词搜索状态" role="status">
                {keywordStatusText(searchHealth)}
              </span>
              <span aria-label="语义索引状态" role="status">
                {semanticStatusText(searchHealth)}
              </span>
            </div>
            {searchError ? <p className="operation-error" role="alert">{searchError}</p> : null}
          </div>
          <div className="data-operation-actions">
            <button
              className="secondary-button"
              disabled={rebuildBusy}
              onClick={() => void rebuildSearchIndex()}
              type="button"
            >
              {rebuildBusy ? "正在重建…" : "开始重建"}
            </button>
          </div>
        </li>
      </ul>
    </section>
  );
}

interface PublicExport {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  completedAt?: string;
  downloadUrl?: string;
}

interface RestoreInspection {
  id: string;
  status: "valid";
  formatVersion: number;
  recordCount: number;
  canRestore: boolean;
  blockingReason?: "INSTANCE_NOT_EMPTY";
}

interface RestoreResult {
  id: string;
  status: "succeeded";
  recordCount: number;
}

interface SearchHealth {
  keyword: { status: "ready" };
  semantic: {
    status: "paused" | "building" | "ready";
    model: string;
    configurationVersion: number;
    readyDocuments: number;
    totalDocuments: number;
  };
}

async function createExport(signal: AbortSignal): Promise<PublicExport> {
  const body = await requestJson<{ export: PublicExport }>(
    "/api/v1/exports",
    { method: "POST", signal },
  );

  return body.export;
}

async function waitForExport(
  initial: PublicExport,
  signal: AbortSignal,
): Promise<PublicExport> {
  let current = initial;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (current.status === "succeeded" || current.status === "failed") {
      return current;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const body = await requestJson<{ export: PublicExport }>(
      `/api/v1/exports/${encodeURIComponent(current.id)}`,
      { signal },
    );

    current = body.export;
  }

  throw new Error("导出生成超时，请重试。");
}

async function inspectRestoreArchive(
  archive: File,
  signal: AbortSignal,
): Promise<RestoreInspection> {
  const body = await requestJson<{ inspection: RestoreInspection }>(
    "/api/v1/restores/inspect",
    {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: archive,
      signal,
    },
  );

  return body.inspection;
}

async function commitRestore(
  inspectionId: string,
  signal: AbortSignal,
): Promise<RestoreResult> {
  const body = await requestJson<{ restore: RestoreResult }>(
    "/api/v1/restores",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inspectionId }),
      signal,
    },
  );

  return body.restore;
}

async function getSearchHealth(signal: AbortSignal): Promise<SearchHealth> {
  return requestJson<SearchHealth>("/api/v1/search-health", { signal });
}

async function requestSearchRebuild(signal: AbortSignal): Promise<void> {
  await requestJson("/api/v1/search-index/rebuild", {
    method: "POST",
    signal,
  });
}

async function requestJson<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T | ApiErrorBody;

  if (!response.ok) {
    const error = (body as ApiErrorBody).error;

    if (typeof error === "object" && error) {
      throw new Error(`${error.code} · ${error.message}`);
    }

    throw new Error(typeof error === "string" ? error : "请求失败，请重试。");
  }

  return body as T;
}

interface ApiErrorBody {
  error?: string | { code: string; message: string };
}

function exportStatusText(job: PublicExport | null, busy: boolean): string {
  if (busy || job?.status === "queued" || job?.status === "running") {
    return "正在生成完整导出包…";
  }

  if (job?.status === "succeeded") {
    return "导出完成";
  }

  return "尚未生成导出包";
}

function restoreStatusText(state: {
  archive: File | null;
  inspection: RestoreInspection | null;
  inspectionBusy: boolean;
  restoreBusy: boolean;
  restoreError: string;
  restoreResult: RestoreResult | null;
}): string {
  if (state.restoreError) {
    return state.restoreError;
  }

  if (state.restoreBusy) {
    return "正在原子恢复领域数据…";
  }

  if (state.inspectionBusy) {
    return "正在检查恢复包结构与引用…";
  }

  if (state.restoreResult) {
    return `恢复完成 · ${state.restoreResult.recordCount} 条记录`;
  }

  if (state.inspection?.canRestore) {
    return (
      `检查通过 · 格式 v${state.inspection.formatVersion} · ` +
      `${state.inspection.recordCount} 条记录，可以执行恢复。`
    );
  }

  if (state.inspection?.blockingReason === "INSTANCE_NOT_EMPTY") {
    return "INSTANCE_NOT_EMPTY · 当前实例已有领域数据，V1 只能恢复到空实例。";
  }

  return state.archive
    ? `已选择 ${state.archive.name}，等待检查。`
    : "尚未选择恢复包";
}

function keywordStatusText(health: SearchHealth | null): string {
  return health?.keyword.status === "ready" ? "可用" : "检查中…";
}

function semanticStatusText(health: SearchHealth | null): string {
  if (!health) {
    return "检查中…";
  }

  const progress = `${health.semantic.readyDocuments}/${health.semantic.totalDocuments}`;

  if (health.semantic.status === "ready") {
    return `健康 · ${progress}`;
  }

  if (health.semantic.status === "building") {
    return `重建中 · ${progress}`;
  }

  return `已暂停 · ${progress}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function PanelHeading({
  eyebrow,
  summary,
  title,
}: {
  eyebrow: string;
  summary: string;
  title: string;
}) {
  return (
    <header className="settings-panel-heading">
      <div>
        <p>{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <p>{summary}</p>
    </header>
  );
}

function endpointLabel(kind: "text" | "embedding"): string {
  return kind === "text" ? "文本推理模型" : "嵌入模型";
}

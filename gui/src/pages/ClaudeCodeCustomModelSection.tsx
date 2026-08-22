import { useCallback, useEffect, useMemo, useState } from "react";
import { IconX } from "../icons";
import { Notice, Switch } from "../ui";
import { useT } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";

interface ApiKeyItem {
  id: string;
  key: string;
  label?: string;
}

interface SettingsJsonResponse {
  path: string;
  exists: boolean;
  env: Record<string, string>;
  model?: string;
  apiKeys?: ApiKeyItem[];
  availableModels?: string[];
  defaultEndpoint?: string;
}

const DEFAULT_PROXY_TOKEN = "opencodex-proxy";

export function ClaudeCodeCustomModelSection({
  apiBase,
  availableModels: initialModels = [],
  port = 20128,
}: {
  apiBase: string;
  availableModels?: string[];
  port?: number;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(true);
  const [settingsPath, setSettingsPath] = useState("");

  const defaultEp = `http://127.0.0.1:${port}/v1`;

  // Current applied endpoint (saved on disk in settings.json)
  const [currentEndpoint, setCurrentEndpoint] = useState("");
  // Selected / Draft endpoint to be saved
  const [selectedEndpoint, setSelectedEndpoint] = useState(defaultEp);

  const [apiKey, setApiKey] = useState(DEFAULT_PROXY_TOKEN);
  const [fableModel, setFableModel] = useState("");
  const [opusModel, setOpusModel] = useState("");
  const [sonnetModel, setSonnetModel] = useState("");
  const [haikuModel, setHaikuModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [enableDiscovery, setEnableDiscovery] = useState(true);

  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [models, setModels] = useState<string[]>(initialModels);

  // Model Picker Modal state
  type TargetField = "fable" | "opus" | "sonnet" | "haiku" | "custom" | null;
  const [pickerTarget, setPickerTarget] = useState<TargetField>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/claude-code/settings-json`);
      const data = await readJsonOrThrow<SettingsJsonResponse>(res, "Failed to load Claude Code settings.json");
      if (!data) return;
      setSettingsPath(data.path || "");
      const env = data.env || {};
      const appliedEp = env.ANTHROPIC_BASE_URL || "";
      setCurrentEndpoint(appliedEp || defaultEp);
      setSelectedEndpoint(appliedEp || data.defaultEndpoint || defaultEp);

      setApiKey(env.ANTHROPIC_AUTH_TOKEN || DEFAULT_PROXY_TOKEN);
      setFableModel(env.ANTHROPIC_DEFAULT_FABLE_MODEL || "");
      setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL || "");
      setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL || "");
      setHaikuModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "");
      setCustomModel(env.ANTHROPIC_CUSTOM_MODEL_OPTION || "");
      setEnableDiscovery(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1");
      if (data.apiKeys && Array.isArray(data.apiKeys)) setApiKeys(data.apiKeys);
      if (data.availableModels && Array.isArray(data.availableModels) && data.availableModels.length > 0) {
        setModels(data.availableModels);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setOk(false);
    }
  }, [apiBase, defaultEp]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const saveSettings = async () => {
    setSaving(true);
    setStatus("");
    try {
      const payload = {
        env: {
          ANTHROPIC_BASE_URL: selectedEndpoint.trim(),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ANTHROPIC_AUTH_TOKEN: apiKey.trim(),
          ANTHROPIC_DEFAULT_FABLE_MODEL: fableModel.trim(),
          ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel.trim(),
          ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel.trim(),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel.trim(),
          ANTHROPIC_CUSTOM_MODEL_OPTION: customModel.trim(),
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: enableDiscovery ? "1" : null,
        },
      };

      const res = await fetch(`${apiBase}/api/claude-code/settings-json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await readJsonOrThrow(res, "Failed to save Claude Code settings.json");
      setOk(true);
      setCurrentEndpoint(selectedEndpoint.trim());
      setStatus(t("claude.customModel.savedSuccess"));
      await loadSettings();
    } catch (err) {
      setOk(false);
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const alreadySelectedBares = useMemo(() => {
    const bares = new Set<string>();
    if (pickerTarget !== "fable" && fableModel) bares.add(fableModel.toLowerCase());
    if (pickerTarget !== "opus" && opusModel) bares.add(opusModel.toLowerCase());
    if (pickerTarget !== "sonnet" && sonnetModel) bares.add(sonnetModel.toLowerCase());
    if (pickerTarget !== "haiku" && haikuModel) bares.add(haikuModel.toLowerCase());
    if (pickerTarget !== "custom" && customModel) bares.add(customModel.toLowerCase());
    return bares;
  }, [pickerTarget, fableModel, opusModel, sonnetModel, haikuModel, customModel]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return models.filter(m => {
      if (alreadySelectedBares.has(m.toLowerCase())) return false;
      if (!q) return true;
      return m.toLowerCase().includes(q);
    });
  }, [models, searchQuery, alreadySelectedBares]);

  const selectModelForTarget = (selected: string) => {
    if (pickerTarget === "fable") setFableModel(selected);
    else if (pickerTarget === "opus") setOpusModel(selected);
    else if (pickerTarget === "sonnet") setSonnetModel(selected);
    else if (pickerTarget === "haiku") setHaikuModel(selected);
    else if (pickerTarget === "custom") setCustomModel(selected);
    setPickerTarget(null);
    setSearchQuery("");
  };

  const endpointChoices = useMemo(() => [
    `http://127.0.0.1:${port}/v1`,
    `http://localhost:${port}/v1`,
  ], [port]);

  const targetTitle = useMemo(() => {
    switch (pickerTarget) {
      case "fable": return t("claude.customModel.fable");
      case "opus": return t("claude.customModel.opus");
      case "sonnet": return t("claude.customModel.sonnet");
      case "haiku": return t("claude.customModel.haiku");
      case "custom": return t("claude.customModel.customOption");
      default: return t("claude.workspace.models");
    }
  }, [pickerTarget, t]);

  return (
    <div className="card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      {status && (
        <div style={{ marginBottom: "8px" }}>
          <Notice tone={ok ? "ok" : "err"}>
            {status}
          </Notice>
        </div>
      )}

      {settingsPath && (
        <div style={{ fontSize: "12px", color: "var(--muted)", wordBreak: "break-all" }}>
          📁 <code>{t("claude.customModel.configFile", { path: settingsPath })}</code>
        </div>
      )}

      {/* Select Endpoint Row */}
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", alignItems: "center", gap: "12px" }}>
        <div style={{ fontWeight: "600", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          <span>{t("claude.customModel.selectEndpoint")}</span>
          <span style={{ color: "var(--muted)" }}>→</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", maxWidth: "550px" }}>
          <select
            className="input"
            value={endpointChoices.includes(selectedEndpoint) ? selectedEndpoint : "__custom__"}
            onChange={e => {
              if (e.target.value !== "__custom__") {
                setSelectedEndpoint(e.target.value);
              }
            }}
            style={{ width: "180px", flexShrink: 0 }}
          >
            {endpointChoices.map(ep => (
              <option key={ep} value={ep}>{ep}</option>
            ))}
            <option value="__custom__">{t("claude.customModel.customUrlOption")}</option>
          </select>
          <input
            className="input mono"
            value={selectedEndpoint}
            onChange={e => setSelectedEndpoint(e.target.value)}
            style={{ flex: 1 }}
            placeholder={`http://127.0.0.1:${port}/v1`}
          />
        </div>
      </div>

      {/* Current Endpoint display (Read-only, only updates on apply/save) */}
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", alignItems: "center", gap: "12px" }}>
        <div style={{ fontWeight: "600", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          <span>{t("claude.customModel.current")}</span>
          <span style={{ color: "var(--muted)" }}>→</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", maxWidth: "550px" }}>
          <input
            className="input mono"
            value={currentEndpoint || t("claude.customModel.currentEmpty")}
            readOnly
            disabled
            style={{
              width: "100%",
              opacity: 0.85,
              cursor: "default",
              backgroundColor: "var(--raised)",
            }}
          />
        </div>
      </div>

      {/* Khóa API (API Key) */}
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", alignItems: "center", gap: "12px" }}>
        <div style={{ fontWeight: "600", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          <span>{t("claude.customModel.apiKey")}</span>
          <span style={{ color: "var(--muted)" }}>→</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", maxWidth: "550px", width: "100%" }}>
          <select
            className="input"
            value={apiKey === DEFAULT_PROXY_TOKEN ? DEFAULT_PROXY_TOKEN : apiKeys.some(k => k.key === apiKey) ? apiKey : "__custom__"}
            onChange={e => {
              if (e.target.value !== "__custom__") {
                setApiKey(e.target.value);
              }
            }}
            style={{ width: "200px", flexShrink: 0 }}
            title={t("claude.customModel.apiKey")}
          >
            <option value={DEFAULT_PROXY_TOKEN}>{DEFAULT_PROXY_TOKEN} {t("claude.customModel.default")}</option>
            {apiKeys.map(k => (
              <option key={k.id} value={k.key}>
                {k.label ? `${k.label} (${k.key.slice(0, 8)}...)` : `${k.key.slice(0, 12)}...`}
              </option>
            ))}
            <option value="__custom__">{t("claude.customModel.customKeyOption")}</option>
          </select>
          <input
            className="input mono"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={t("claude.customModel.apiKeyPlaceholder")}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />

      {/* Model Slot: Claude Fable */}
      <ModelSlotRow
        label={t("claude.customModel.fable")}
        value={fableModel}
        placeholder="nov/claude-fable-5[1m]"
        selectLabel={t("claude.customModel.selectModel")}
        clearLabel={t("claude.customModel.clearValue")}
        onChange={setFableModel}
        onSelect={() => { setPickerTarget("fable"); setSearchQuery(""); }}
        onClear={() => setFableModel("")}
      />

      {/* Model Slot: Claude Opus */}
      <ModelSlotRow
        label={t("claude.customModel.opus")}
        value={opusModel}
        placeholder="jd/claude-opus-5[1m]"
        selectLabel={t("claude.customModel.selectModel")}
        clearLabel={t("claude.customModel.clearValue")}
        onChange={setOpusModel}
        onSelect={() => { setPickerTarget("opus"); setSearchQuery(""); }}
        onClear={() => setOpusModel("")}
      />

      {/* Model Slot: Claude Sonnet */}
      <ModelSlotRow
        label={t("claude.customModel.sonnet")}
        value={sonnetModel}
        placeholder="go/claude-opus-5[1m]"
        selectLabel={t("claude.customModel.selectModel")}
        clearLabel={t("claude.customModel.clearValue")}
        onChange={setSonnetModel}
        onSelect={() => { setPickerTarget("sonnet"); setSearchQuery(""); }}
        onClear={() => setSonnetModel("")}
      />

      {/* Model Slot: Claude Haiku */}
      <ModelSlotRow
        label={t("claude.customModel.haiku")}
        value={haikuModel}
        placeholder="ftb/deepseek-v4-flash-0731"
        selectLabel={t("claude.customModel.selectModel")}
        clearLabel={t("claude.customModel.clearValue")}
        onChange={setHaikuModel}
        onSelect={() => { setPickerTarget("haiku"); setSearchQuery(""); }}
        onClear={() => setHaikuModel("")}
      />

      {/* Model Slot: Custom Model Option */}
      <ModelSlotRow
        label={t("claude.customModel.customOption")}
        value={customModel}
        placeholder="test[1m]"
        selectLabel={t("claude.customModel.selectModel")}
        clearLabel={t("claude.customModel.clearValue")}
        onChange={setCustomModel}
        onSelect={() => { setPickerTarget("custom"); setSearchQuery(""); }}
        onClear={() => setCustomModel("")}
      />

      {/* Toggle: Show All Available Models */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          marginTop: "6px",
          backgroundColor: "var(--raised)",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border-soft)",
          maxWidth: "742px",
        }}
      >
        <div>
          <div style={{ fontWeight: "600", fontSize: "14px" }}>Show All Available Models</div>
          <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
            <code style={{ fontSize: "11px" }}>CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY</code>
          </div>
        </div>
        <Switch
          on={enableDiscovery}
          onClick={() => setEnableDiscovery(!enableDiscovery)}
          label="Show All Available Models"
        />
      </div>

      {/* Save Button */}
      <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saveSettings()}
          disabled={saving}
          style={{ minWidth: "120px" }}
        >
          {saving ? t("claude.customModel.saving") : t("claude.customModel.saveBtn")}
        </button>
      </div>

      {/* Model Picker Modal */}
      {pickerTarget !== null && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setPickerTarget(null)}
        >
          <div
            className="modal-card"
            style={{ maxWidth: "550px", width: "90%" }}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: "16px" }}>
                {t("claude.customModel.modalTitle", { target: targetTitle })}
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => setPickerTarget(null)}
                aria-label={t("common.close")}
              >
                <IconX />
              </button>
            </div>

            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <input
                className="input"
                type="search"
                placeholder={t("claude.customModel.searchPlaceholder")}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoFocus
                style={{ width: "100%" }}
              />

              <div style={{ maxHeight: "360px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
                {filteredModels.length === 0 ? (
                  <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)" }}>
                    {t("claude.customModel.noModelsFound")}
                  </div>
                ) : (
                  filteredModels.map(m => (
                    <button
                      key={m}
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => selectModelForTarget(m)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        textAlign: "left",
                        padding: "8px 12px",
                        width: "100%",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      <code style={{ fontSize: "13px" }}>{m}</code>
                      {m.includes("[1m]") && (
                        <span className="badge badge-green" style={{ fontSize: "11px", marginLeft: "8px" }}>1M</span>
                      )}
                    </button>
                  ))
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setPickerTarget(null)}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function toCanonicalModelKey(key: string): string {
  if (!key) return "";
  let clean = key.replace(/\[1m\]/gi, "").trim().toLowerCase();
  
  if (clean.startsWith("claude-ocx-") || clean.startsWith("claude-ocx2-")) {
    const rest = clean.replace(/^claude-ocx2?-/, "");
    const parts = rest.split("--");
    if (parts.length >= 2) {
      const provider = parts[0];
      const model = parts.slice(1).join("--").replaceAll("~s", "/").replaceAll("~t", "~");
      return `${provider}/${model}`;
    }
  }

  const match = /^(.+?)\s*\((.+?)\)$/.exec(clean);
  if (match) {
    const [, model, provider] = match;
    return `${provider.trim()}/${model.trim()}`;
  }

  return clean;
}

export function is1mModelActive(
  candidate: string,
  discovery1mList: string[] = []
): boolean {
  if (!candidate) return false;
  if (candidate.includes("[1m]")) return true;
  const targetKey = toCanonicalModelKey(candidate);
  if (!targetKey) return false;

  for (const d of discovery1mList) {
    if (toCanonicalModelKey(d) === targetKey) return true;
  }
  return false;
}

export function parseModelValue(val: string): { bare: string; has1m: boolean } {
  const trimmed = val.trim();
  if (trimmed.endsWith("[1m]")) {
    return { bare: trimmed.slice(0, -4).trim(), has1m: true };
  }
  return { bare: trimmed, has1m: false };
}

export function composeModelValue(bare: string, has1m: boolean): string {
  const clean = bare.trim();
  if (!clean) return "";
  return has1m ? `${clean}[1m]` : clean;
}

function ModelSlotRow({
  label,
  value,
  placeholder,
  selectLabel,
  clearLabel,
  onChange,
  onSelect,
  onClear,
}: {
  label: string;
  value: string;
  placeholder?: string;
  selectLabel: string;
  clearLabel: string;
  onChange: (val: string) => void;
  onSelect: () => void;
  onClear: () => void;
}) {
  const { bare, has1m } = parseModelValue(value);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    if (text.includes("[1m]")) {
      const clean = text.replace(/\[1m\]/gi, "").trim();
      onChange(composeModelValue(clean, true));
    } else {
      onChange(composeModelValue(text, has1m));
    }
  };

  const handleToggle1m = () => {
    if (!bare) return;
    onChange(composeModelValue(bare, !has1m));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", alignItems: "center", gap: "12px" }}>
      <div style={{ fontWeight: "600", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span>{label}</span>
        <span style={{ color: "var(--muted)" }}>→</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", maxWidth: "550px" }}>
        <input
          className="input mono"
          value={bare}
          onChange={handleInputChange}
          placeholder={placeholder?.replace(/\[1m\]/gi, "")}
          style={{ flex: 1 }}
        />
        {/* 1M Toggle Button to the left of X button */}
        <button
          type="button"
          onClick={handleToggle1m}
          disabled={!bare}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2px 8px",
            borderRadius: "9999px",
            fontSize: "11px",
            fontWeight: "700",
            cursor: bare ? "pointer" : "default",
            border: has1m ? "1px solid var(--green, #22c55e)" : "1px solid rgba(255, 255, 255, 0.25)",
            backgroundColor: has1m ? "var(--green-soft, rgba(34, 197, 94, 0.18))" : "rgba(255, 255, 255, 0.08)",
            color: has1m ? "var(--green, #22c55e)" : "#d4d4d4",
            boxShadow: has1m ? "0 0 8px rgba(34, 197, 94, 0.35)" : "none",
            transition: "all 0.15s ease-in-out",
            userSelect: "none",
            flexShrink: 0,
            opacity: bare ? 1 : 0.4,
          }}
        >
          1M
        </button>
        {value && (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClear}
            title={clearLabel}
            aria-label={clearLabel}
            style={{ color: "var(--muted)", flexShrink: 0 }}
          >
            <IconX width={14} height={14} />
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onSelect}
          style={{ whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {selectLabel}
        </button>
      </div>
    </div>
  );
}

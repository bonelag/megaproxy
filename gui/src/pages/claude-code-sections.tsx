import { useMemo, useState } from "react";
import { IconPlus, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { Select } from "../ui";
import {
  applySidecarBackendChange,
  applySidecarModelChange,
  sidecarSelectValue,
  type SidecarSelectValue,
} from "./claude-code-sidecar";
import { AutoConnectSetting, SettingToggle } from "./claude-code-settings";
import type { ClaudeCodeState, MapRow } from "./claude-code-types";
import { newClientId } from "./claude-code-types";
import { is1mModelActive, toCanonicalModelKey } from "./ClaudeCodeCustomModelSection";
import type { TFn, TKey } from "../i18n/shared";

/**
 * Which detector proved the Claude login. Falls back to a generic label so an
 * unrecognised source id from a newer backend never renders a raw key.
 */
function authSourceLabel(source: string | undefined, t: TFn): string {
  const known = ["claude-json-oauth", "claude-credentials-file", "macos-keychain", "exported-env"];
  return source && known.includes(source)
    ? t(`claude.authSource.${source}` as TKey)
    : t("claude.authSource.unknown");
}

export function ClaudeCodeSettingsCard({
  state,
  autoCompactOptions,
  availableModels,
  onStateChange,
}: {
  state: ClaudeCodeState;
  autoCompactOptions: { value: string; label: string }[];
  availableModels: string[];
  onStateChange: (next: ClaudeCodeState) => void;
}) {
  const t = useT();

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {/*
        The connection toggle lives in the Claude Code header, where it commits
        immediately. Keeping a copy here as a Save-gated draft row meant one
        setting with two controls and two different commit semantics — a user
        who flipped this one and navigated away had changed nothing.
      */}
      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claude.authMode")}</span>
          <span className="desc">{t("claude.authModeHint")}</span>
        </div>
        <div className="setting-controls">
          <Select
            value={state.authMode}
            options={[
              { value: "auto", label: t("claude.authModeAuto") },
              { value: "subscription", label: t("claude.authModeSubscription") },
              { value: "proxy", label: t("claude.authModeProxy") },
            ]}
            onChange={v => onStateChange({ ...state, authMode: v as ClaudeCodeState["authMode"] })}
            label={t("claude.authMode")}
            style={{ minWidth: 220 }}
            align="right"
            portal
          />
        </div>
      </div>

      {state.authModeOrigin && (
        <div className={`claude-effective-auth${state.authModeOrigin === "auto-unknown" ? " warn" : ""}`} role="status">
          <span className="claude-effective-auth-label">{t("claude.effectiveMode.label")}</span>
          <span>
            {state.authModeOrigin === "manual"
              ? t("claude.effectiveMode.manual", {
                mode: state.markerMode === "proxy" ? t("claude.authModeProxy") : t("claude.authModeSubscription"),
              })
              : state.authModeOrigin === "auto-present"
                ? t("claude.effectiveMode.autoPresent", { source: authSourceLabel(state.authFoundBy, t) })
                : state.authModeOrigin === "auto-absent"
                  ? t("claude.effectiveMode.autoAbsent")
                  : t("claude.effectiveMode.autoUnknown")}
            {state.admissionKeyActive === true ? ` ${t("claude.effectiveMode.admissionKey")}` : ""}
          </span>
        </div>
      )}

      <AutoConnectSetting
        supported={state.autoConnectSupported}
        checked={state.systemEnv}
        onChange={systemEnv => onStateChange({ ...state, systemEnv })}
      />

      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claude.fastMode")}</span>
          <span className="desc">{t("claude.fastModeDesc")}</span>
        </div>
        <div className="setting-controls">
          <Select
            value={state.fastMode === null ? "auto" : state.fastMode ? "on" : "off"}
            options={[
              { value: "auto", label: t("claude.fastAuto") },
              { value: "on", label: t("claude.fastOn") },
              { value: "off", label: t("claude.fastOff") },
            ]}
            onChange={v => onStateChange({ ...state, fastMode: v === "auto" ? null : v === "on" })}
            label={t("claude.fastMode")}
            style={{ minWidth: 140 }}
            align="right"
            portal
          />
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claude.autoContext")}</span>
          <span className="desc">{t("claude.autoContextDesc")}</span>
          {state.maxContextTokens !== null && <span className="desc" style={{ color: "var(--muted)" }}>{t("claude.autoContextInert")}</span>}
        </div>
        <SettingToggle label={t("claude.autoContext")} checked={state.autoContext} onChange={autoContext => onStateChange({ ...state, autoContext })} />
      </div>

      {state.autoContext && (
        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.autoCompactWindow")}</span>
            <span className="desc">{t("claude.autoCompactWindowDesc")}</span>
            {state.autoCompactWindow !== null && <span className="desc" style={{ color: "var(--red)" }}>{t("claude.autoCompactWindowWarn")}</span>}
          </div>
          <div className="setting-controls">
            <Select
              value={state.autoCompactWindow === null ? "" : String(state.autoCompactWindow)}
              options={autoCompactOptions}
              onChange={v => onStateChange({ ...state, autoCompactWindow: v === "" ? null : Number(v) })}
              label={t("claude.autoCompactWindow")}
              style={{ minWidth: 130 }}
              align="right"
              portal
            />
          </div>
        </div>
      )}

      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claude.injectAgents")}</span>
          <span className="desc">{t("claude.injectAgentsDesc")}</span>
        </div>
        <SettingToggle label={t("claude.injectAgents")} checked={state.injectAgents} onChange={injectAgents => onStateChange({ ...state, injectAgents })} />
      </div>

      {(["webSearchSidecar", "visionSidecar"] as const).map(key => {
        const override = state[key];
        const titleKey = key === "webSearchSidecar" ? "claude.webSearchSidecar" : "claude.visionSidecar";
        const hintKey = key === "webSearchSidecar" ? "claude.webSearchSidecarHint" : "claude.visionSidecarHint";
        const listId = `claude-sidecar-models-${key}`;
        return (
          <div className="setting-row" key={key} style={{ alignItems: "flex-start" }}>
            <div className="setting-label setting-copy" style={{ flex: 1 }}>
              <span className="title">{t(titleKey)}</span>
              <span className="desc">{t(hintKey)}</span>
            </div>
            <div className="setting-controls" style={{ display: "flex", gap: 8 }}>
              <Select
                value={sidecarSelectValue(override)}
                options={[
                  { value: "inherit", label: t("claude.useMainSetting") },
                  { value: "auto", label: t("dash.backendAuto") },
                  { value: "openai", label: t("dash.backendOpenAI") },
                  { value: "anthropic", label: t("dash.backendAnthropic") },
                ]}
                onChange={value => {
                  // Auto may exist as an empty in-memory draft so the model input
                  // stays enabled; empty Auto serializes to null on save.
                  onStateChange({
                    ...state,
                    [key]: applySidecarBackendChange(override, value as SidecarSelectValue),
                  });
                }}
                label={t("dash.sidecarBackend")}
                portal
              />
              <input
                className="input mono"
                value={override?.model ?? ""}
                onChange={e => {
                  onStateChange({
                    ...state,
                    [key]: applySidecarModelChange(override, e.target.value),
                  });
                }}
                placeholder={t("claude.sidecarModelPlaceholder")}
                disabled={!override}
                list={override ? listId : undefined}
                aria-label={t("dash.sidecarModel")}
                style={{ minWidth: 210 }}
                autoComplete="off"
              />
              {override && (
                <datalist id={listId}>
                  {availableModels.map(m => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ClaudeCodeQuickstartSection({ manualEnv }: { manualEnv: string }) {
  const t = useT();
  // Title lives in ClaudeCode's shared ccw-main-head so every rail pane shares one top inset.
  return (
    <>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}><Trans k="claude.quickstartHint" cmd="ocx claude" /></p>
      <pre className="mono card" style={{ padding: "10px 14px", overflowX: "auto", margin: 0 }}>ocx claude</pre>
      <details style={{ margin: "10px 0 0" }}>
        <summary className="muted text-label" style={{ cursor: "pointer", padding: "2px 2px" }}>{t("claude.manualEnv")}</summary>
        <pre className="mono card text-label" style={{ padding: "10px 14px", overflowX: "auto", margin: "6px 0 0" }}>{manualEnv}</pre>
      </details>
    </>
  );
}

export function ClaudeCodeModelMapSection({
  rows,
  onRowsChange,
}: {
  rows: MapRow[];
  onRowsChange: (rows: MapRow[]) => void;
}) {
  const t = useT();
  // Title + count live in ClaudeCode's shared ccw-main-head (stable across rail panes).
  return (
    <>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>{t("claude.modelMapHint")}</p>
      <div className="stack" style={{ gap: 8 }}>
        {rows.map((row, i) => (
          <div key={row.id} className="row" style={{ gap: 8 }}>
            <input
              className="input mono"
              value={row.from}
              placeholder={t("claude.mapFrom")}
              aria-label={t("claude.mapFrom")}
              onChange={e => onRowsChange(rows.map((r, j) => j === i ? { ...r, from: e.target.value } : r))}
              style={{ flex: 1 }}
            />
            <span className="muted" aria-hidden>→</span>
            <input
              className="input mono"
              value={row.to}
              placeholder={t("claude.mapTo")}
              aria-label={t("claude.mapTo")}
              onChange={e => onRowsChange(rows.map((r, j) => j === i ? { ...r, to: e.target.value } : r))}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onRowsChange(rows.filter((_, j) => j !== i))}
              aria-label={t("claude.removeMapping")} style={{ color: "var(--red)" }}>
              <IconX />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRowsChange([...rows, { id: newClientId(), from: "", to: "" }])}>
          <IconPlus /> {t("claude.addMapping")}
        </button>
      </div>
    </>
  );
}

type AliasRow = { id: string; display_name: string };

/** Sentinel bucket key for aliases whose display_name has no trailing `(provider)`. */
const ALIAS_PROVIDER_OTHER = "etc";

function groupAliasesByProvider(aliases: AliasRow[]): Array<[string, AliasRow[]]> {
  const groups = new Map<string, AliasRow[]>();
  for (const alias of aliases) {
    const match = /\(([^)]+)\)\s*$/.exec(alias.display_name);
    const provider = match ? match[1]! : ALIAS_PROVIDER_OTHER;
    const bucket = groups.get(provider);
    if (bucket) bucket.push(alias);
    else groups.set(provider, [alias]);
  }
  return Array.from(groups);
}

export function ClaudeCodeAliasesSection({
  aliases,
  discovery1mModels = [],
  onChangeDiscovery1m,
}: {
  aliases: AliasRow[];
  discovery1mModels?: string[];
  onChangeDiscovery1m?: (models: string[]) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");

  const is1mActive = (id: string, dn?: string) => {
    return is1mModelActive(id, discovery1mModels) || (dn ? is1mModelActive(dn, discovery1mModels) : false);
  };

  const toggle1m = (id: string, dn?: string) => {
    const key = toCanonicalModelKey(id) || (dn ? toCanonicalModelKey(dn) : "");
    const active = is1mActive(id, dn);
    let nextModels: string[];
    if (active) {
      nextModels = discovery1mModels.filter(m => toCanonicalModelKey(m) !== key);
    } else {
      nextModels = [...discovery1mModels.filter(m => toCanonicalModelKey(m) !== key), id];
    }
    if (onChangeDiscovery1m) {
      onChangeDiscovery1m(nextModels);
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return aliases;
    const q = search.trim().toLowerCase();
    return aliases.filter(a => a.id.toLowerCase().includes(q) || a.display_name.toLowerCase().includes(q));
  }, [aliases, search]);

  const groups = useMemo(() => groupAliasesByProvider(filtered), [filtered]);

  return (
    <div className="claude-aliases" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <p className="muted text-label" style={{ margin: 0 }}>
          {t("claude.aliasesHint")}
        </p>
        <input
          type="search"
          className="input"
          placeholder={t("claude.customModel.searchPlaceholder") || "Search models..."}
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: "240px", height: "32px", fontSize: "12px" }}
        />
      </div>

      {aliases.length === 0 ? (
        <div className="muted text-label">{t("claude.none")}</div>
      ) : groups.length === 0 ? (
        <div className="muted text-label" style={{ padding: "16px 0" }}>No models matching "{search}"</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {groups.map(([provider, aliasRows]) => (
            <div key={provider} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "700", fontSize: "12px", letterSpacing: "0.5px", color: "var(--muted)", textTransform: "uppercase" }}>
                <span>{provider === ALIAS_PROVIDER_OTHER ? t("claude.aliasProviderOther") : provider}</span>
                <span className="badge" style={{ fontSize: "10px", padding: "1px 6px" }}>{aliasRows.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {aliasRows.map(a => {
                  const on = is1mActive(a.id, a.display_name);
                  return (
                    <div
                      key={a.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 12px",
                        backgroundColor: "var(--raised)",
                        borderRadius: "var(--radius-sm)",
                        border: "1px solid var(--border-soft)",
                        gap: "12px",
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--fg)" }}>
                            {a.display_name || a.id}
                          </span>
                        </div>
                        {a.display_name ? (
                          <code className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                            {a.id}
                          </code>
                        ) : null}
                      </div>

                      <button
                        type="button"
                        onClick={() => toggle1m(a.id, a.display_name)}
                        title={on ? "1M Context: ON (appends [1m] in discovery)" : "1M Context: OFF"}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "3px 10px",
                          borderRadius: "9999px",
                          fontSize: "11px",
                          fontWeight: "700",
                          cursor: "pointer",
                          border: on ? "1px solid var(--green, #22c55e)" : "1px solid rgba(255, 255, 255, 0.25)",
                          backgroundColor: on ? "var(--green-soft, rgba(34, 197, 94, 0.18))" : "rgba(255, 255, 255, 0.08)",
                          color: on ? "var(--green, #22c55e)" : "#d4d4d4",
                          boxShadow: on ? "0 0 8px rgba(34, 197, 94, 0.35)" : "none",
                          transition: "all 0.15s ease-in-out",
                          userSelect: "none",
                          flexShrink: 0,
                        }}
                      >
                        1M
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

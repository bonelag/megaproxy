/**
 * Shared Custom User-Agent + Custom Headers editor for Add Provider and Settings.
 * Settings seeds full values from GET; Add starts empty.
 */
import { useT } from "../i18n/shared";
import {
  newHeaderRow,
  type ProviderHeaderRow,
} from "../provider-headers";

export default function ProviderHeadersEditor({
  userAgent,
  rows,
  onUserAgentChange,
  onRowsChange,
  onTouch,
  disabled = false,
  idPrefix = "provider-headers",
}: {
  userAgent: string;
  rows: ProviderHeaderRow[];
  onUserAgentChange: (value: string) => void;
  onRowsChange: (rows: ProviderHeaderRow[]) => void;
  /** Fired when the operator edits anything in this section (dirty / PATCH gate). */
  onTouch?: () => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const t = useT();

  const touch = () => onTouch?.();

  const updateRow = (id: string, patch: Partial<Pick<ProviderHeaderRow, "name" | "value">>) => {
    touch();
    onRowsChange(rows.map(row => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    touch();
    onRowsChange(rows.filter(row => row.id !== id));
  };

  const addRow = () => {
    touch();
    onRowsChange([...rows, newHeaderRow()]);
  };

  const clearAll = () => {
    touch();
    onUserAgentChange("");
    onRowsChange([]);
  };

  return (
    <div className="provider-headers-editor" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label className="pwi-settings-field modal-field" htmlFor={`${idPrefix}-ua`}>
        <span className="pwi-settings-label">{t("modal.userAgent")}</span>
        <input
          id={`${idPrefix}-ua`}
          className="input"
          value={userAgent}
          disabled={disabled}
          onChange={e => {
            touch();
            onUserAgentChange(e.target.value);
          }}
          placeholder={t("modal.userAgentPlaceholder")}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="muted text-hint">{t("modal.userAgentHint")}</span>
      </label>

      <div className="provider-headers-block">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div className="pwi-settings-label">{t("modal.customHeaders")}</div>
            <div className="muted text-hint">{t("modal.customHeadersHint")}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {(userAgent.trim() || rows.some(r => r.name.trim() || r.value.trim())) && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={clearAll}>
                {t("pws.clearHeaders")}
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={addRow}>
              + {t("modal.addHeader")}
            </button>
          </div>
        </div>

        {rows.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {rows.map(row => (
              <div key={row.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  value={row.name}
                  disabled={disabled}
                  placeholder={t("modal.headerName")}
                  aria-label={t("modal.headerName")}
                  onChange={e => updateRow(row.id, { name: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <input
                  className="input"
                  value={row.value}
                  disabled={disabled}
                  placeholder={t("modal.headerValue")}
                  aria-label={t("modal.headerValue")}
                  onChange={e => updateRow(row.id, { value: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ flex: 1.4, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={disabled}
                  aria-label={t("pws.removeHeader")}
                  onClick={() => removeRow(row.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

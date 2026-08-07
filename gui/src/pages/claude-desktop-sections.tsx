/**
 * Claude Desktop settings categories.
 *
 * One exported section per rail tab so a future setting lands in an existing category
 * instead of growing the page component. Every section is presentational: it receives
 * the draft profile and reports edits upward, and the page owns fetching and saving.
 */
import type { ChangeEvent, DragEvent } from "react";
import { IconChevron } from "../icons";
import { useT, type TFn } from "../i18n/shared";
import { SettingToggle } from "./claude-code-settings";
import { LANE_PAGE, laneView } from "./claude-desktop-lane";
import {
  FAMILIES,
  FAMILY_KEYS,
  cloneAssignment,
  effective1m,
  formatContextWindow,
  type Assignment,
  type DesktopModel,
  type DesktopProfile,
  type Family,
} from "./claude-desktop-types";

/** General category: settings that apply to the whole applied config, not one model. */
export function ClaudeDesktopGeneralSection({
  chatTabEnabled,
  onChatTabChange,
}: {
  chatTabEnabled: boolean;
  onChatTabChange: (value: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claudeDesktop.chatTab")}</span>
          <span className="desc">{t("claudeDesktop.chatTabDesc")}</span>
        </div>
        <SettingToggle
          label={t("claudeDesktop.chatTab")}
          checked={chatTabEnabled}
          onChange={onChatTabChange}
        />
      </div>
    </div>
  );
}

/** Profile category: the whole-profile JSON round trip. */
export function ClaudeDesktopProfileSection({
  onImportClick,
  onExport,
  importInput,
}: {
  onImportClick: () => void;
  onExport: () => void;
  importInput: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="claude-desktop-profile-io">
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>
        {t("claudeDesktop.profileIoHint")}
      </p>
      {importInput}
      <div className="claude-profile-tools">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onImportClick}>
          {t("claudeDesktop.importJson")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onExport}>
          {t("claudeDesktop.exportJson")}
        </button>
      </div>
    </div>
  );
}

function ModelRow({
  model,
  family,
  profile,
  destination,
  rowOpen,
  onToggleRow,
  onSetDefault,
  onDestinationChange,
  onMove,
  onAssignmentChange,
  t,
}: {
  model: DesktopModel;
  family: Family;
  profile: DesktopProfile;
  destination: Family;
  rowOpen: boolean;
  onToggleRow: () => void;
  onSetDefault: () => void;
  onDestinationChange: (next: Family) => void;
  onMove: () => void;
  onAssignmentChange: (next: Assignment) => void;
  t: TFn;
}) {
  const assignment = profile.assignments[model.route]!;
  const context = formatContextWindow(model.contextWindow, t);
  const auto = model.autoSupports1m ?? false;
  const { supports1m, prefer1m } = effective1m(assignment, auto);
  const isDefault = profile.defaults[family] === model.route;
  const bodyId = `claude-model-body-${model.route}`;
  const preferHintId = `claude-prefer1m-hint-${model.route}`;

  return (
    <article
      className={`claude-model-card${rowOpen ? " open" : ""}`}
      draggable
      onDragStart={event => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", model.route);
      }}
    >
      {/* Summary: identification and triage only. Context, 1M and effort stay OUT of the
          fold because they are what you scan to pick a default — only edit affordances hide. */}
      <button
        type="button"
        className="claude-model-summary"
        aria-expanded={rowOpen}
        aria-controls={bodyId}
        onClick={onToggleRow}
      >
        <IconChevron
          className="ocx-chevron"
          width={12}
          height={12}
          aria-hidden="true"
          style={{ transform: rowOpen ? "rotate(90deg)" : "none" }}
        />
        <span className="claude-model-names">
          <strong title={model.label}>{model.label}</strong>
          <code title={model.route}>{model.route}</code>
        </span>
        {context && <span className="claude-model-context">{context}</span>}
        {/* Distinguish "we do not know the window" from "we know it is small". */}
        {!context && (
          <span className="claude-model-context claude-model-context-unknown">
            {t("claudeDesktop.contextUnknown")}
          </span>
        )}
        {supports1m && <span className="claude-1m-chip">{t("claudeDesktop.supports1m")}</span>}
        {prefer1m && <span className="claude-1m-chip claude-1m-chip-prefer">{t("claudeDesktop.prefer1mChip")}</span>}
        {model.effortSupported === false && (
          <span className="claude-effort-badge off">{t("claudeDesktop.effort.displayOnly")}</span>
        )}
        {model.effortSupported === true && (
          <span className="claude-effort-badge on">{t("claudeDesktop.effort.supported")}</span>
        )}
        {isDefault && <span className="claude-row-default">{t("claudeDesktop.defaultBadge")}</span>}
      </button>

      {rowOpen && (
        <div className="claude-model-body" id={bodyId}>
          <div className="claude-field">
            <span>{t("claudeDesktop.alias")}</span>
            <code className="claude-alias" title={assignment.alias}>{assignment.alias}</code>
          </div>

          <label className="claude-default-radio">
            <input
              type="radio"
              name={`default-${family}`}
              checked={isDefault}
              onChange={onSetDefault}
            />
            {t("claudeDesktop.useAsDefault", { family: t(FAMILY_KEYS[family]) })}
          </label>

          {/* 1M pins are per-model config, so they live with the model rather than in a
              global category. prefer1m stays disabled until support is on: the writer
              ignores preference without support, and a live-looking control would lie. */}
          <div className="claude-model-settings">
            <div className="setting-row">
              <div className="setting-label">
                <span className="title">{t("claudeDesktop.supports1mLabel")}</span>
                <span className="desc">
                  {auto ? t("claudeDesktop.supports1mAuto") : t("claudeDesktop.supports1mManual")}
                </span>
              </div>
              <SettingToggle
                label={t("claudeDesktop.supports1mLabel")}
                checked={supports1m}
                onChange={next => onAssignmentChange({
                  ...cloneAssignment(assignment),
                  supports1m: next,
                  // Turning support off must clear preference, not leave a stale true
                  // that the parser would reject and the writer would ignore.
                  ...(next ? {} : { prefer1m: false }),
                })}
              />
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <span className="title">{t("claudeDesktop.prefer1mLabel")}</span>
                <span className="desc" id={preferHintId}>
                  {supports1m ? t("claudeDesktop.prefer1mDesc") : t("claudeDesktop.prefer1mRequires")}
                </span>
              </div>
              <SettingToggle
                label={t("claudeDesktop.prefer1mLabel")}
                checked={prefer1m}
                disabled={!supports1m}
                describedBy={preferHintId}
                onChange={next => onAssignmentChange({
                  ...cloneAssignment(assignment),
                  supports1m: true,
                  prefer1m: next,
                })}
              />
            </div>
          </div>

          <div className="claude-move-row">
            <label htmlFor={`move-${model.route}`}>{t("claudeDesktop.moveTo")}</label>
            <select
              id={`move-${model.route}`}
              className="input"
              value={destination}
              onChange={event => onDestinationChange(event.target.value as Family)}
            >
              {FAMILIES.map(option => (
                <option key={option} value={option}>{t(FAMILY_KEYS[option])}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={destination === family}
              onClick={onMove}
            >
              {t("claudeDesktop.move")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * One family category.
 *
 * Only AVAILABLE models are rendered: a disabled provider's models cannot be assigned
 * or made default, so listing them was a wall of dead rows. They stay in the profile —
 * dropping them would lose the alias and the save route rejects a changed assignment
 * for an unavailable route — and a footnote reports how many are hidden.
 */
export function ClaudeDesktopFamilySection({
  family,
  models,
  hiddenUnavailable,
  profile,
  destinations,
  openRows,
  search,
  limit,
  familyDefault,
  onSearchChange,
  onLimitChange,
  onToggleRow,
  onSetDefault,
  onDestinationChange,
  onMove,
  onAssignmentChange,
  onDropRoute,
}: {
  family: Family;
  models: DesktopModel[];
  hiddenUnavailable: number;
  profile: DesktopProfile;
  destinations: Record<string, Family>;
  openRows: Record<string, boolean>;
  search: string;
  limit: number;
  familyDefault: string | null;
  onSearchChange: (next: string) => void;
  onLimitChange: (next: number) => void;
  onToggleRow: (route: string) => void;
  onSetDefault: (route: string) => void;
  onDestinationChange: (route: string, next: Family) => void;
  onMove: (route: string) => void;
  onAssignmentChange: (route: string, next: Assignment) => void;
  onDropRoute: (route: string) => void;
}) {
  const t = useT();
  const lane = laneView(models, search, limit);

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const route = event.dataTransfer.getData("text/plain");
    if (route) onDropRoute(route);
  };

  return (
    <div
      className="claude-family-pane"
      onDragOver={event => event.preventDefault()}
      onDrop={handleDrop}
    >
      {profile.defaults[family] === null && models.length > 0 && (
        <p className="claude-default-needed" role="status">{t("claudeDesktop.chooseDefault")}</p>
      )}
      {familyDefault && familyDefault !== profile.defaults[family] && (
        <p className="claude-default-needed" role="status" title={familyDefault}>
          {t("claudeDesktop.temporaryDefault")}
        </p>
      )}

      {lane.showSearch && (
        <input
          className="input claude-lane-search"
          type="search"
          placeholder={t("models.search")}
          aria-label={t("models.search")}
          value={search}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onSearchChange(event.target.value);
            // A new query starts from the first page; otherwise a previously expanded lane
            // would hide the very matches the user just searched for.
            onLimitChange(LANE_PAGE);
          }}
        />
      )}

      <div className="claude-lane-models">
        {models.length === 0 ? (
          <div className="claude-lane-empty">{t("claudeDesktop.laneEmpty")}</div>
        ) : lane.noMatch ? (
          <div className="claude-lane-empty">{t("claudeDesktop.laneNoMatch")}</div>
        ) : lane.shown.map(model => (
          <ModelRow
            key={model.route}
            model={model}
            family={family}
            profile={profile}
            destination={destinations[model.route] ?? family}
            rowOpen={openRows[model.route] ?? model.route === familyDefault}
            onToggleRow={() => onToggleRow(model.route)}
            onSetDefault={() => onSetDefault(model.route)}
            onDestinationChange={next => onDestinationChange(model.route, next)}
            onMove={() => onMove(model.route)}
            onAssignmentChange={next => onAssignmentChange(model.route, next)}
            t={t}
          />
        ))}
        {lane.hidden > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm claude-lane-more"
            onClick={() => onLimitChange(limit + LANE_PAGE)}
          >
            {t("models.showMore", { n: lane.hidden })}
          </button>
        )}
      </div>

      {hiddenUnavailable > 0 && (
        <p className="claude-hidden-note">
          {t("claudeDesktop.hiddenUnavailable", { count: hiddenUnavailable })}
        </p>
      )}
    </div>
  );
}

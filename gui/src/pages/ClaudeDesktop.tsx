import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { LANE_PAGE } from "./claude-desktop-lane";
import { EmptyState, Notice } from "../ui";
import { LOCALES, useI18n } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import {
  ClaudeDesktopFamilySection,
  ClaudeDesktopGeneralSection,
  ClaudeDesktopProfileSection,
} from "./claude-desktop-sections";
import {
  FAMILIES,
  FAMILY_KEYS,
  cloneAssignment,
  cloneProfile,
  errorMessage,
  normalizeProfile,
  type Assignment,
  type DesktopModel,
  type DesktopProfile,
  type DesktopResponse,
  type DesktopStatus,
  type Family,
  type PendingAction,
} from "./claude-desktop-types";

type CachedDesktop = { data: DesktopResponse; profile: DesktopProfile };

function readDesktopCache(cacheKey: string): CachedDesktop | null {
  return readSessionListCache<CachedDesktop>(cacheKey);
}

function seedDesktop(cacheKey: string) {
  const cached = readDesktopCache(cacheKey);
  return {
    held: cached,
    data: cached?.data ?? null,
    profile: cached?.profile ?? null,
    savedProfile: cached?.profile ? cloneProfile(cached.profile) : null,
    destinations: cached?.data
      ? Object.fromEntries(
        cached.data.models.map(model => [model.route, cached.profile.assignments[model.route]?.family ?? "opus"]),
      )
      : {} as Record<string, Family>,
  };
}

export default function ClaudeDesktop({
  apiBase,
  active = true,
  onPortChange,
}: {
  apiBase: string;
  active?: boolean;
  /** Keeps the Claude page intro subtitle in sync once /api/claude-desktop settles (port or failure). */
  onPortChange?: (port: number | null) => void;
}) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const cacheKey = `ocx.claude-desktop.v1:${apiBase}`;
  const resourceKey = `claude-desktop:${apiBase}`;
  const cached = useMemo(() => seedDesktop(cacheKey), [cacheKey]);
  const [draftProfile, setProfile] = useState<DesktopProfile | null>(() => cached.profile);
  const [savedDraftProfile, setSavedProfile] = useState<DesktopProfile | null>(() => cached.savedProfile);
  const [draftDestinations, setDestinations] = useState<Record<string, Family>>(() => cached.destinations);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  /*
   * Rail selection mirrors Claude Code: one category per pane instead of four
   * stacked collapsibles. The family panes replace the old fold state entirely —
   * a rail row IS the disclosure, so a second collapse layer would be two
   * controls for one decision.
   */
  const [selectedSection, setSelectedSection] = useState("general");
  // Lane density: search and paging are RENDER-ONLY. modelsByFamily and effectiveDefaults must
  // keep seeing every model — filtering the source arrays would silently change which model is
  // the effective default, turning a view filter into a data mutation.
  const [laneSearch, setLaneSearch] = useState<Record<string, string>>({});
  const [laneLimit, setLaneLimit] = useState<Record<string, number>>({});
  // Which rows the user has explicitly opened or closed. Deliberately NOT persisted:
  // a category selection is a durable preference, but which single model you were
  // inspecting is not.
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const importRef = useRef<HTMLInputElement>(null);

  const fetchDesktop = useCallback(async (signal: AbortSignal): Promise<CachedDesktop> => {
    const response = await fetch(`${apiBase}/api/claude-desktop`, { signal });
    const payload = await readJsonOrThrow<DesktopResponse | { error?: string }>(
      response,
      t("claudeDesktop.loadFail"),
    );
    if (!payload || !("profile" in payload) || !("models" in payload)) {
      throw new Error(errorMessage(payload, t("claudeDesktop.loadFail")));
    }
    const normalized = normalizeProfile(payload);
    const next = { data: payload, profile: normalized };
    if (signal.aborted) throw new Error("Claude Desktop request aborted");
    // A successful read is authoritative until the user edits again. Updating drafts here keeps
    // the established save→reload contract without synchronizing resource data in an effect.
    setProfile(normalized);
    setSavedProfile(cloneProfile(normalized));
    setDestinations(Object.fromEntries(payload.models.map(model => [model.route, normalized.assignments[model.route]?.family ?? "opus"])));
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t, setDestinations, setProfile, setSavedProfile]);

  const desktopResource = useDataSurface<CachedDesktop>(
    resourceKey,
    [apiBase],
    fetchDesktop,
    { isEmpty: () => false, enabled: active, initialData: cached.held ?? undefined },
  );
  const loadState = desktopResource.state;
  const resourceData = loadState.data ?? (cached.data && cached.profile ? { data: cached.data, profile: cached.profile } : null);
  const data = resourceData?.data ?? null;
  const profile = draftProfile ?? resourceData?.profile ?? null;
  const savedProfile = savedDraftProfile ?? resourceData?.profile ?? null;
  const resourceDestinations = resourceData
    ? Object.fromEntries(resourceData.data.models.map(model => [model.route, resourceData.profile.assignments[model.route]?.family ?? "opus"]))
    : {} as Record<string, Family>;
  const destinations = Object.keys(draftDestinations).length > 0 ? draftDestinations : resourceDestinations;

  useEffect(() => {
    if (!onPortChange) return;
    if (typeof data?.port === "number") {
      onPortChange(data.port);
      return;
    }
    // Cold failure with no port: stop the parent subtitle from claiming "Loading…" forever.
    if (loadState.kind === "failed-cold") onPortChange(null);
  }, [data?.port, loadState.kind, onPortChange]);

  const dirty = useMemo(
    () => profile !== null && savedProfile !== null && JSON.stringify(profile) !== JSON.stringify(savedProfile),
    [profile, savedProfile],
  );

  /**
   * Availability split.
   *
   * Only available models are rendered, but the FULL grouping still drives
   * `effectiveDefaults` — a family whose stored default went unavailable must still
   * resolve to an available sibling rather than reporting none.
   */
  const grouped = useMemo(() => {
    const shown = Object.fromEntries(FAMILIES.map(family => [family, [] as DesktopModel[]])) as Record<Family, DesktopModel[]>;
    const hidden = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<Family, number>;
    if (!data || !profile) return { shown, hidden };
    for (const model of data.models) {
      const family = profile.assignments[model.route]?.family ?? "opus";
      if (model.available) shown[family].push(model);
      else hidden[family] += 1;
    }
    return { shown, hidden };
  }, [data, profile]);

  const effectiveDefaults = useMemo(() => {
    const result = {} as Record<Family, string | null>;
    for (const family of FAMILIES) {
      const active = grouped.shown[family].map(model => model.route).sort();
      const stored = profile?.defaults[family] ?? null;
      result[family] = stored && active.includes(stored) ? stored : (active[0] ?? null);
    }
    return result;
  }, [grouped, profile]);

  // The status poll is a separate resource: visibility pauses it without unmounting the
  // profile editor, which keeps its drafts intact across Code/Desktop tab switches.
  const statusCacheKey = `ocx.claude-desktop.status.v1:${apiBase}`;
  const statusResourceKey = `claude-desktop-status:${apiBase}`;
  const cachedStatus = readSessionListCache<DesktopStatus>(statusCacheKey);
  const statusResource = useDataSurface<DesktopStatus>(
    statusResourceKey,
    [apiBase],
    async (signal) => {
      const response = await fetch(`${apiBase}/api/claude-desktop/status`, { signal });
      const next = await readJsonIfOk<DesktopStatus>(response);
      if (!next) throw new Error("Claude Desktop status unavailable");
      writeSessionListCache(statusCacheKey, next);
      return next;
    },
    { isEmpty: () => false, pollMs: 5000, enabled: active, initialData: cachedStatus ?? undefined },
  );
  const statusState = statusResource.state;
  const status = statusState.data ?? cachedStatus ?? null;
  const statusFailed = statusState.showError;

  const moveModel = (route: string, family: Family) => {
    if (!profile || profile.assignments[route]?.family === family) return;
    // Availability of the CURRENT catalog, needed to pick a replacement default. The save
    // route refuses an unavailable default while a live sibling exists, so choosing the
    // plain alphabetical first member could make the very next Save fail.
    const availableRoutes = new Set((data?.models ?? []).filter(model => model.available).map(model => model.route));
    setProfile(current => {
      if (!current) return current;
      const previous = current.assignments[route];
      if (!previous || previous.family === family) return current;
      const assignments = { ...current.assignments, [route]: { ...cloneAssignment(previous), family } };
      const defaults = { ...current.defaults };
      if (defaults[previous.family] === route) {
        const siblings = Object.keys(assignments)
          .filter(key => key !== route && assignments[key]!.family === previous.family)
          .sort();
        // Prefer a live sibling; fall back to an unavailable one only when the family has
        // nothing else left, which the save route now accepts.
        defaults[previous.family] = siblings.find(key => availableRoutes.has(key)) ?? siblings[0] ?? null;
      }
      if (defaults[family] === null) defaults[family] = route;
      return { ...current, assignments, defaults };
    });
    setDestinations(current => ({ ...current, [route]: family }));
    setAnnouncement(t("claudeDesktop.moved", { route, family: t(FAMILY_KEYS[family]) }));
  };

  const updateAssignment = (route: string, next: Assignment) => {
    setProfile(current => {
      if (!current || !current.assignments[route]) return current;
      return { ...current, assignments: { ...current.assignments, [route]: next } };
    });
  };

  const save = async (applyAfter: boolean) => {
    if (!profile || pending) return;
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("claudeDesktop.saveFailed"));
      setSavedProfile(cloneProfile(profile));

      if (applyAfter) {
        setPending("apply");
        const applyResponse = await fetch(`${apiBase}/api/claude-desktop/apply`, { method: "POST" });
        await readJsonOrThrow<{ error?: string }>(applyResponse, t("claudeDesktop.applyFailed"));
        setMessage({ tone: "ok", text: t("claudeDesktop.savedApplied") });
        setAnnouncement(t("claudeDesktop.savedAppliedAnnounce"));
      } else {
        setMessage({ tone: "ok", text: t("claudeDesktop.saved") });
        setAnnouncement(t("claudeDesktop.savedAnnounce"));
      }
      // Apply/save change the bar tone; do not wait for the 5s poll or the strip flips late.
      void statusResource.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : t("claudeDesktop.updateFailed");
      setMessage({ tone: "err", text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  const exportProfile = () => {
    if (!profile) return;
    // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- file content newline, not UI text
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(profile, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "claude-desktop-profile.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement(t("claudeDesktop.exported"));
  };

  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const candidate = JSON.parse(await file.text()) as Partial<DesktopProfile>;
      if (candidate.version !== 1 || !candidate.assignments || !candidate.defaults) throw new Error(t("claudeDesktop.importExpected"));
      const imported = normalizeProfile({ ...data!, profile: candidate as DesktopProfile });
      setProfile(imported);
      setMessage({ tone: "ok", text: t("claudeDesktop.importReady") });
      setAnnouncement(t("claudeDesktop.importedAnnounce"));
    } catch (error) {
      const text = error instanceof Error ? error.message : t("claudeDesktop.importInvalid");
      setMessage({ tone: "err", text });
      setAnnouncement(t("claudeDesktop.importFailed", { error: text }));
    }
  };

  if (loadState.kind === "disabled" && !resourceData) return null;
  if (loadState.showSkeleton && !resourceData) {
    return <DataSurfaceSkeleton label={t("claudeDesktop.loading")} rows={4} />;
  }
  if (loadState.kind === "failed-cold") {
    const reason = loadState.error instanceof Error ? loadState.error.message : t("claudeDesktop.loadFail");
    return (
      <div className="claude-desktop-error">
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost" onClick={() => desktopResource.refresh()}>{t("claudeDesktop.retry")}</button>
      </div>
    );
  }
  if (!data || !profile) return null;

  const sections: Array<{ id: string; label: string; meta?: string; body: ReactNode }> = [
    {
      id: "general",
      label: t("claudeDesktop.section.general"),
      body: (
        <ClaudeDesktopGeneralSection
          chatTabEnabled={profile.chatTabEnabled !== false}
          onChatTabChange={chatTabEnabled => setProfile(current => current && ({ ...current, chatTabEnabled }))}
        />
      ),
    },
    ...FAMILIES.map(family => ({
      id: `family-${family}`,
      label: t(FAMILY_KEYS[family]),
      meta: String(grouped.shown[family].length),
      body: (
        <ClaudeDesktopFamilySection
          family={family}
          models={grouped.shown[family]}
          hiddenUnavailable={grouped.hidden[family]}
          profile={profile}
          destinations={destinations}
          openRows={openRows}
          search={laneSearch[family] ?? ""}
          limit={laneLimit[family] ?? LANE_PAGE}
          familyDefault={effectiveDefaults[family]}
          onSearchChange={next => setLaneSearch(current => ({ ...current, [family]: next }))}
          onLimitChange={next => setLaneLimit(current => ({ ...current, [family]: next }))}
          onToggleRow={route => setOpenRows(current => ({
            ...current,
            [route]: !(current[route] ?? route === effectiveDefaults[family]),
          }))}
          onSetDefault={route => setProfile(current => current && ({
            ...current,
            defaults: { ...current.defaults, [family]: route },
          }))}
          onDestinationChange={(route, next) => setDestinations(current => ({ ...current, [route]: next }))}
          onMove={route => moveModel(route, destinations[route] ?? family)}
          onAssignmentChange={updateAssignment}
          onDropRoute={route => moveModel(route, family)}
        />
      ),
    })),
    {
      id: "profileIo",
      label: t("claudeDesktop.section.profileIo"),
      body: (
        <ClaudeDesktopProfileSection
          onImportClick={() => importRef.current?.click()}
          onExport={exportProfile}
          importInput={(
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={event => void importProfile(event)}
            />
          )}
        />
      ),
    },
  ];
  const selected = sections.find(section => section.id === selectedSection) ?? sections[0]!;

  return (
    <div className="claudecode-workspace-shell">
      {/* Title/subtitle live on Claude.tsx above the Code/Desktop strip. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {loadState.showError && <Notice tone="err">{t("claudeDesktop.loadFail")}</Notice>}
      {statusFailed && status && <Notice tone="err">{t("claudeDesktop.loadFail")}</Notice>}

      {/* Always mount the bar (pending strut when status is still cold) so a late /status
          response cannot insert a full row under the title and shove the panes down. */}
      <div
        className={`claude-status-bar ${
          statusFailed && !status
            ? "not-applied"
            : !status
              ? "pending"
              : status.activeProfile === false
                ? "not-applied"
                : status.stale
                  ? "stale"
                  : status.applied
                    ? "applied"
                    : "not-applied"
        }`}
        aria-busy={(!status && !statusFailed) || undefined}
      >
        <span className="claude-status-dot" />
        {/* Desktop serving another profile outranks content drift: stale config that is
            read still works, a config that is never read does not. */}
        <span>
          {statusFailed && !status
            ? t("claudeDesktop.loadFail")
            : !status
              ? t("claudeDesktop.loading")
              : status.activeProfile === false
                ? t("claudeDesktop.status.notActiveProfile")
                : status.stale
                  ? t("claudeDesktop.status.stale")
                  : status.applied
                    ? t("claudeDesktop.status.applied")
                    : t("claudeDesktop.status.notApplied")}
        </span>
        {status?.health.lastRequestAt && (
          <span className="claude-status-health">
            {t("claudeDesktop.health.lastRequest")}:{" "}
            {new Date(status.health.lastRequestAt).toLocaleTimeString(localeTag)}
          </span>
        )}
        {status && status.health.requestCount > 0 && (
          <span className="claude-status-health">
            {t("claudeDesktop.health.stats", { count: status.health.requestCount, errors: status.health.errorCount })}
          </span>
        )}
      </div>

      {data.models.length === 0 && (
        <EmptyState title={t("claudeDesktop.emptyTitle")}>{t("claudeDesktop.emptyHint")}</EmptyState>
      )}

      <div className="claudecode-workspace-root">
        <aside className="claudecode-workspace-rail" aria-label={t("claudeDesktop.assignmentsLabel")}>
          <div className="claudecode-workspace-rail-list">
            {sections.map(section => (
              <button
                key={section.id}
                type="button"
                className={`claudecode-workspace-rail-row${selectedSection === section.id ? " claudecode-workspace-rail-row--selected" : ""}`}
                onClick={() => setSelectedSection(section.id)}
                aria-current={selectedSection === section.id ? "true" : undefined}
              >
                <span className="claudecode-workspace-rail-name">{section.label}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="claudecode-workspace-main" aria-label={selected.label}>
          <div className="ccw-main-head">
            <h3 className="ccw-main-title">
              {selected.label}
              {selected.meta != null ? <span className="count">{selected.meta}</span> : null}
            </h3>
            {/* Save is profile-wide, so it stays mounted for every pane — unlike Code,
                where some panes are read-only. The dirty label keeps its own slot. */}
            <div className="claudecode-workspace-save">
              <span className={`claude-dirty${dirty ? " active" : ""}`}>
                {dirty ? t("claudeDesktop.unsaved") : t("claudeDesktop.upToDate")}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!dirty || pending !== null}
                onClick={() => void save(false)}
              >
                {pending === "save" ? t("claudeDesktop.saving") : t("common.save")}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={pending !== null}
                onClick={() => void save(true)}
              >
                {pending === "apply"
                  ? t("claudeDesktop.applying")
                  : pending === "save"
                    ? t("claudeDesktop.saving")
                    : t("claudeDesktop.saveApply")}
              </button>
            </div>
          </div>
          <div className="ccw-body">{selected.body}</div>
        </section>
      </div>
    </div>
  );
}

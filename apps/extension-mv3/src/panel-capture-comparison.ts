import { createCaptureObservation } from "./create-capture-observation";
import { compareCaptureObservations, isCaptureObservation,
  type CaptureComparison, type CaptureObservation } from "./capture-comparison";
import type { UiAttachTranslate } from "./i18n";
import type { ActivePageContext } from "./messages";
import type { PanelSessionSnapshot } from "./panel-session-controller";

export type CaptureObservationReader = (
  page: ActivePageContext, itemId: string, attachmentId: string,
) => Promise<{
  status: "observed" | "checking" | "missing" | "ambiguous" | "stale" | "unavailable";
  observation: CaptureObservation | null;
} | null>;

export function createPanelCaptureComparison(options: {
  anchor: HTMLElement;
  read: CaptureObservationReader;
  clipboard: { writeText(value: string): Promise<void> };
  t: UiAttachTranslate;
}) {
  const { t } = options;
  const doc = options.anchor.ownerDocument;
  const root = doc.createElement("section");
  root.id = "capture-comparison";
  root.className = "capture-comparison";
  root.hidden = true;
  const check = doc.createElement("button");
  check.id = "capture-comparison-check";
  check.type = "button";
  check.className = "utility-action";
  check.textContent = t("comparison_check");
  const copy = doc.createElement("button");
  copy.id = "capture-comparison-copy";
  copy.type = "button";
  copy.className = "utility-action";
  copy.textContent = t("comparison_copy");
  copy.hidden = true;
  const actions = doc.createElement("div");
  actions.className = "capture-comparison-actions";
  actions.append(check, copy);
  const status = doc.createElement("p");
  status.id = "capture-comparison-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const changes = doc.createElement("div");
  changes.id = "capture-comparison-changes";
  root.append(actions, status, changes);
  options.anchor.after(root);
  let scope: {
    key: string; page: ActivePageContext; itemId: string; attachmentId: string;
    baseline: CaptureObservation;
  } | null = null;
  let revision = 0;
  let result: CaptureComparison | null = null;
  let pending = false;
  let disposed = false;
  let initialized = false;
  doc.defaultView?.addEventListener("pagehide", () => { disposed = true; revision += 1; }, { once: true });

  function sync(snapshot: PanelSessionSnapshot, selectedIsCurrent: boolean): void {
    const item = snapshot.file?.session.attachments.find((candidate) => candidate.id === snapshot.selectedItemId);
    const baseline = item ? createCaptureObservation(item.sourceRecord.attachment) : null;
    const page = snapshot.activePage;
    const eligible = selectedIsCurrent && snapshot.activeSupported && !snapshot.clearPending &&
      !snapshot.sessionMutationPending && snapshot.epoch && page && item && baseline;
    const next = eligible ? {
      key: JSON.stringify([snapshot.epoch, item.id, item.sourceRecord.attachment.id, page, baseline]),
      page: structuredClone(page), itemId: item.id,
      attachmentId: item.sourceRecord.attachment.id, baseline,
    } : null;
    root.hidden = !item;
    if (initialized && scope?.key === next?.key) return;
    initialized = true;
    scope = next;
    revision += 1;
    pending = false;
    result = null;
    changes.replaceChildren();
    copy.hidden = true;
    copy.disabled = false;
    check.disabled = !scope;
    check.textContent = t("comparison_check");
    status.textContent = t(scope ? "comparison_hint" : "comparison_unavailable");
  }

  check.addEventListener("click", () => { void observe(); });
  async function observe(): Promise<void> {
    if (!scope || pending || disposed) return;
    const request = scope;
    const requestRevision = ++revision;
    pending = true;
    result = null;
    copy.hidden = true;
    changes.replaceChildren();
    check.disabled = true;
    status.textContent = t("comparison_checking");
    try {
      const response = await options.read(request.page, request.itemId, request.attachmentId);
      if (disposed || !root.isConnected || requestRevision !== revision || scope?.key !== request.key) return;
      if (response?.status !== "observed" || !isCaptureObservation(response.observation)) {
        const state = response?.status;
        status.textContent = t(state === "missing" ? "comparison_missing"
          : state === "ambiguous" ? "comparison_ambiguous" : "comparison_unavailable");
        return;
      }
      result = compareCaptureObservations(request.baseline, response.observation);
      renderResult(result);
    } catch {
      if (requestRevision === revision && !disposed) status.textContent = t("comparison_unavailable");
    } finally {
      if (requestRevision === revision && !disposed) {
        pending = false;
        check.disabled = !scope;
      }
    }
  }

  function renderResult(value: CaptureComparison): void {
    status.textContent = t(value.changes.length ? "comparison_changed" : "comparison_unchanged", {
      count: value.changes.length, compared: value.comparedFieldCount,
    });
    const timestamps = doc.createElement("p");
    timestamps.className = "muted";
    timestamps.textContent = t("comparison_times", {
      before: value.baselineCapturedAt, after: value.observedAt,
    });
    changes.append(timestamps);
    if (value.changes.length) {
      const list = doc.createElement("dl");
      list.className = "capture-comparison-list";
      for (const change of value.changes) {
        const row = doc.createElement("div");
        const label = doc.createElement("dt");
        label.textContent = t(`comparison_${change.field.replaceAll(".", "_")}`);
        const values = doc.createElement("dd");
        const before = doc.createElement("span");
        const after = doc.createElement("span");
        before.textContent = `${t("comparison_before")}: ${formatValue(change.before)}`;
        after.textContent = `${t("comparison_after")}: ${formatValue(change.after)}`;
        values.append(before, after);
        row.append(label, values);
        list.append(row);
      }
      changes.append(list);
    }
    if (value.unavailableFields.length) {
      const unavailable = doc.createElement("p");
      unavailable.className = "muted";
      unavailable.textContent = t("comparison_partial", { count: value.unavailableFields.length });
      changes.append(unavailable);
    }
    const boundary = doc.createElement("p");
    boundary.className = "muted";
    boundary.textContent = t("comparison_boundary");
    changes.append(boundary);
    copy.hidden = false;
    copy.disabled = false;
    copy.textContent = t("comparison_copy");
  }

  function formatValue(value: string | number | boolean | null): string {
    if (value === null || value === "") return t("comparison_empty");
    if (typeof value === "boolean") return t(value ? "comparison_yes" : "comparison_no");
    return String(value);
  }

  copy.addEventListener("click", () => {
    if (!result || !scope || disposed) return;
    const requestRevision = revision;
    const payload = JSON.stringify({
      kind: "meanthis.capture-comparison", authority: "observed_fields_only",
      identity: "current_matching_candidate", completion: "requires_user_review",
      route: `${scope.page.origin}${scope.page.pathname}`, itemId: scope.itemId,
      geometry: "viewport_css_pixels_rounded_to_0.1", ...result,
    }, null, 2);
    copy.disabled = true;
    void options.clipboard.writeText(payload).then(() => {
      if (requestRevision === revision && !disposed) copy.textContent = t("comparison_copied");
    }).catch(() => {
      if (requestRevision === revision && !disposed) status.textContent = t("comparison_copy_failed");
    }).finally(() => {
      if (requestRevision === revision && !disposed) copy.disabled = false;
    });
  });
  return { sync };
}

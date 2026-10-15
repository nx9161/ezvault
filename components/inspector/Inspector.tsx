// SPDX-License-Identifier: MIT
// Right inspector — selection-contextual (0 / 1 / N selected).
// Tabs: Viewer / Metadata / Notes / Selections. Design §1.4.

"use client";

import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { usePhotos, useSelections, thumbUrl } from "@/lib/api/hooks";
import { editsDirty } from "@/lib/api/types";
import { runCommand, trashSubjectsOp } from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";
import { ExportIcon, TrashIcon, CloseIcon } from "@/components/ui/icons";
import { EmptyArt } from "@/components/ui/EmptyArt";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import PhotoViewer from "./PhotoViewer";
import MetadataForm from "./MetadataForm";
import NotesPanel from "./NotesPanel";
import SelectionsPanel from "./SelectionsPanel";
import type { InspectorTab } from "@/lib/store/ui";

const TABS: InspectorTab[] = ["viewer", "metadata", "notes", "selections"];

function PhotoStrip({
  projectId,
  itemId,
}: {
  projectId: string;
  itemId: string;
}) {
  const { data: photosData } = usePhotos(projectId, itemId);
  const photos = photosData?.items ?? [];
  const activePhotoId = useUiStore((s) => s.activePhotoId);
  const setActivePhotoId = useUiStore((s) => s.setActivePhotoId);
  if (photos.length <= 1) return null;
  return (
    <div
      style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto", paddingBottom: 4 }}
      role="tablist"
      aria-label="photos"
    >
      {photos.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={p.id === activePhotoId}
          onClick={() => setActivePhotoId(p.id)}
          title={`${p.filename} (${i + 1}/${photos.length})`}
          style={{
            border: p.id === activePhotoId ? "2px solid var(--accent)" : "2px solid transparent",
            borderRadius: 6,
            padding: 0,
            background: "none",
            cursor: "pointer",
            position: "relative",
            flex: "0 0 auto",
          }}
        >
          <img
            src={thumbUrl(projectId, p.id)}
            alt=""
            loading="lazy"
            decoding="async"
            style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 4, display: "block" }}
          />
          {editsDirty(p.edits) ? (
            <span
              aria-hidden="true"
              style={{
                position: "absolute", top: 2, right: 2, width: 8, height: 8,
                borderRadius: "50%", background: "var(--accent)",
              }}
            />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function SingleItemInspector({ projectId, itemId }: { projectId: string; itemId: string }) {
  const t = useTranslations("inspector");
  const ctx = useOpContext(projectId);
  const inspectorTab = useUiStore((s) => s.inspectorTab);
  const setInspectorTab = useUiStore((s) => s.setInspectorTab);
  const activePhotoId = useUiStore((s) => s.activePhotoId);
  const setActivePhotoId = useUiStore((s) => s.setActivePhotoId);
  const activeSelectionId = useUiStore((s) => s.activeSelectionId);
  const setActiveSelectionId = useUiStore((s) => s.setActiveSelectionId);
  const setActiveItemId = useUiStore((s) => s.setActiveItemId);
  const setSelectedIds = useUiStore((s) => s.setSelectedIds);

  const { data: photosData, error: photosError, isLoading: photosLoading, mutate: mutatePhotos } = usePhotos(projectId, itemId);
  const photos = photosData?.items ?? [];
  const photo = useMemo(() => {
    if (photos.length === 0) return null;
    return photos.find((p) => p.id === activePhotoId) ?? photos[0];
  }, [photos, activePhotoId]);

  useEffect(() => {
    if (photo && photo.id !== activePhotoId) setActivePhotoId(photo.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id]);

  const { data: selectionsData, mutate: mutateSelections } = useSelections(
    projectId,
    inspectorTab === "viewer" || inspectorTab === "selections" ? (photo?.id ?? null) : null,
  );
  const selections = selectionsData?.items ?? [];
  const activeSelection = selections.find((s) => s.id === activeSelectionId) ?? null;

  const breadcrumb = useMemo(() => {
    const parts = [photo?.filename ?? "…"];
    if (activeSelection) parts.push(activeSelection.name);
    return parts.join(" › ");
  }, [photo, activeSelection]);

  if (photosLoading) {
    return (
      <div className="ez-inspector-body">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (photosError || !photo) {
    return (
      <div className="ez-inspector-body">
        <ErrorCard what="photos" onRetry={() => mutatePhotos()} />
      </div>
    );
  }

  const photoSubjectRoute = `/api/projects/${projectId}/photos/${photo.id}`;
  const metadataSubjectId = activeSelection ? activeSelection.id : photo.id;
  const metadataRoute = activeSelection
    ? `/api/projects/${projectId}/selections/${activeSelection.id}`
    : photoSubjectRoute;

  return (
    <>
      <div className="ez-inspector-head">
        <div className="ez-inspector-breadcrumb">
          <span>{breadcrumb}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ez-icon-btn"
            onClick={() => {
              window.location.href = `/api/projects/${projectId}/photos/${photo.id}/export?format=png`;
            }}
            aria-label={t("exportPhoto")}
            title={t("exportPhoto")}
          >
            <ExportIcon size={15} />
          </button>
          <button
            type="button"
            className="ez-icon-btn"
            onClick={async () => {
              await runCommand(ctx, trashSubjectsOp(ctx, [itemId], "user", t("trashItem")), ["items", "trash", "meter"]);
              setActiveItemId(null);
              setSelectedIds([]);
            }}
            aria-label={t("trashItem")}
            title={t("trashItem")}
          >
            <TrashIcon size={15} />
          </button>
          <button
            type="button"
            className="ez-icon-btn"
            onClick={() => {
              setActiveItemId(null);
            }}
            aria-label={t("closeInspector")}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="ez-tabs" role="tablist" aria-label={t("paneLabel")}>
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={inspectorTab === tab}
              className="ez-tab"
              onClick={() => setInspectorTab(tab)}
            >
              {t(`tabs.${tab}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="ez-inspector-body">
        {inspectorTab === "viewer" ? (
          <>
            <PhotoViewer
              projectId={projectId}
              photo={photo}
              selections={selections}
              activeSelectionId={activeSelectionId}
              onSelectSelection={setActiveSelectionId}
              onSelectionsChanged={() => mutateSelections()}
              ctx={ctx}
            />
            <PhotoStrip projectId={projectId} itemId={itemId} />
          </>
        ) : null}
        {inspectorTab === "metadata" ? (
          <MetadataForm
            projectId={projectId}
            subjectId={metadataSubjectId}
            templateId={activeSelection ? activeSelection.template_id : photo.template_id}
            subjectKind={activeSelection ? "selection" : "photo"}
            subjectRoute={metadataRoute}
            ctx={ctx}
          />
        ) : null}
        {inspectorTab === "notes" ? (
          <NotesPanel
            projectId={projectId}
            photoId={activeSelection ? null : photo.id}
            selectionId={activeSelection ? activeSelection.id : null}
          />
        ) : null}
        {inspectorTab === "selections" ? (
          <SelectionsPanel
            projectId={projectId}
            photoId={photo.id}
            activeSelectionId={activeSelectionId}
            onSelectSelection={setActiveSelectionId}
          />
        ) : null}
      </div>
    </>
  );
}

function BulkInspector({ projectId, subjectIds }: { projectId: string; subjectIds: string[] }) {
  const t = useTranslations("inspector");
  const tm = useTranslations("metadata");
  const ctx = useOpContext(projectId);
  return (
    <div className="ez-inspector-body">
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>{t("bulkTitle", { count: subjectIds.length })}</h2>
      <p style={{ fontSize: 12, color: "var(--ink-2)" }}>{t("bulkHint")}</p>
      <h3 style={{ fontSize: 13, margin: "16px 0 8px" }}>{tm("template")}</h3>
      <MetadataForm
        projectId={projectId}
        subjectId={subjectIds[0]}
        templateId={null}
        subjectKind="item"
        subjectRoute={`/api/projects/${projectId}/items/${subjectIds[0]}`}
        bulk={{ subjectIds }}
        hideTemplatePicker
        ctx={ctx}
      />
    </div>
  );
}

export default function Inspector({ projectId }: { projectId: string }) {
  const t = useTranslations("inspector");
  const activeItemId = useUiStore((s) => s.activeItemId);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);
  // D-M10: inline widths apply only at desktop widths; drawers below 1280px.
  const isDesktop = useMediaQuery("(min-width: 1280px)");

  const bulkIds = selectedIds.length > 1 ? selectedIds : [];

  return (
    <>
      {inspectorOpen ? (
        <div className="ez-scrim" onClick={() => setInspectorOpen(false)} aria-hidden="true" />
      ) : null}
      <aside
        id="ez-inspector"
        className="ez-inspector"
        data-open={inspectorOpen || !!activeItemId || bulkIds.length > 0}
        style={isDesktop ? { width: inspectorWidth } : undefined}
        aria-label={t("paneLabel")}
      >
        {!activeItemId && bulkIds.length === 0 ? (
          <div className="ez-state">
            <EmptyArt variant="inspector" />
            <h2>{t("emptyTitle")}</h2>
            <p>{t("emptyBody")}</p>
          </div>
        ) : bulkIds.length > 0 ? (
          <BulkInspector projectId={projectId} subjectIds={bulkIds} />
        ) : (
          <SingleItemInspector projectId={projectId} itemId={activeItemId!} />
        )}
      </aside>
    </>
  );
}

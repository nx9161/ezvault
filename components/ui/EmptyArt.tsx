// SPDX-License-Identifier: MIT
// Empty-state line art (design D-E4): one original motif — a contact
// sheet whose top-left frame is lifted, the archive awaiting its first
// negative. 1.8px stroke grid language, var(--ink) at 60% opacity, one
// frame in var(--accent). aria-hidden: the headline carries the meaning.

"use client";

interface EmptyArtProps {
  variant?: "library" | "list" | "trash" | "inspector";
  size?: number;
}

const STROKE = "var(--ink)";
const FAINT = "var(--ink)";

function Frames() {
  return (
    <>
      {/* empty slot where the lifted frame was */}
      <rect x="16" y="16" width="30" height="30" stroke={STROKE} strokeDasharray="5 4" opacity="0.45" />
      {/* remaining frames */}
      <rect x="54" y="16" width="30" height="30" stroke={STROKE} opacity="0.6" />
      <rect x="16" y="54" width="30" height="30" stroke={STROKE} opacity="0.6" />
      <rect x="54" y="54" width="30" height="30" stroke="var(--accent)" opacity="0.85" />
      {/* the lifted frame, offset up-right with a soft shadow */}
      <rect x="26" y="22" width="30" height="30" fill="var(--ink)" opacity="0.08" stroke="none" />
      <rect x="22" y="10" width="30" height="30" stroke={STROKE} opacity="0.9" fill="var(--surface)" />
      <circle cx="30" cy="18" r="1.6" fill="var(--accent)" stroke="none" />
    </>
  );
}

function TrashVariant() {
  return (
    <>
      <rect x="16" y="16" width="30" height="30" stroke={STROKE} strokeDasharray="5 4" opacity="0.45" />
      <rect x="54" y="16" width="30" height="30" stroke={STROKE} opacity="0.6" />
      <rect x="16" y="54" width="30" height="30" stroke={STROKE} opacity="0.6" />
      <rect x="54" y="54" width="30" height="30" stroke="var(--accent)" opacity="0.85" />
      {/* small trash glyph in the stroke language */}
      <g stroke={FAINT} opacity="0.9">
        <path d="M22 24h28" />
        <path d="M30 24v-4h12v4" />
        <path d="M25 24l2 22a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2l2-22" />
        <path d="M32 32v10M40 32v10" />
      </g>
    </>
  );
}

function FilmstripVariant() {
  return (
    <>
      <rect x="8" y="32" width="24" height="36" stroke={STROKE} opacity="0.6" />
      <rect x="40" y="32" width="24" height="36" stroke={STROKE} strokeDasharray="5 4" opacity="0.45" />
      <rect x="72" y="32" width="24" height="36" stroke="var(--accent)" opacity="0.85" />
      {/* lifted middle frame */}
      <rect x="44" y="36" width="24" height="36" fill="var(--ink)" opacity="0.08" stroke="none" />
      <rect x="40" y="24" width="24" height="36" stroke={STROKE} opacity="0.9" fill="var(--surface)" />
      <circle cx="47" cy="31" r="1.6" fill="var(--accent)" stroke="none" />
    </>
  );
}

export function EmptyArt({ variant = "library", size = 96 }: EmptyArtProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 104 104"
      fill="none"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ marginBottom: 8 }}
    >
      {variant === "trash" ? <TrashVariant /> : variant === "inspector" ? <FilmstripVariant /> : <Frames />}
    </svg>
  );
}

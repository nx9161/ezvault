// SPDX-License-Identifier: MIT
// Unified inline-SVG icon set (design D-M1). One 24x24 grid, 1.8px stroke,
// round caps/joins, currentColor. Drawn for EZVault — no borrowed artwork.
// Callers needing an accessible name wrap with their own aria-label on the button.

"use client";

import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base(
  size: number,
  props: SVGProps<SVGSVGElement>,
  children: React.ReactNode,
) {
  const { width, height, ...rest } = props;
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function TrashIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7l.9 13.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7" />
      <path d="M10 11v6M14 11v6" />
    </>
  ));
}

export function GridIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ));
}

export function TableIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1" />
      <path d="M3.5 9.7h17M3.5 14.3h17" />
    </>
  ));
}

export function ThemeIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </>
  ));
}

export function SearchIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" />
    </>
  ));
}

export function UndoIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M8.5 13.5L4 9l4.5-4.5" />
      <path d="M4 9h9.5a6 6 0 0 1 0 12H11" />
    </>
  ));
}

export function RedoIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M15.5 13.5L20 9l-4.5-4.5" />
      <path d="M20 9h-9.5a6 6 0 0 0 0 12H13" />
    </>
  ));
}

export function ZoomInIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" />
      <path d="M11 8.2v5.6M8.2 11h5.6" />
    </>
  ));
}

export function ZoomOutIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" />
      <path d="M8.2 11h5.6" />
    </>
  ));
}

// Counter-clockwise.
export function RotateIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M1 4v6h6" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </>
  ));
}

export function RotateCwIcon({ size = 16, ...props }: IconProps) {
  // Clockwise.
  return base(size, props, (
    <>
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </>
  ));
}

export function SelectionDrawIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="4 3" />
  ));
}

export function ExportIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 11L12 15.5 16.5 11" />
      <path d="M5 20.5h14" />
    </>
  ));
}

export function CopyIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ));
}

export function PrintIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M7 8V4h10v4" />
      <rect x="4" y="8" width="16" height="8" rx="2" />
      <path d="M7 13h10v7H7z" />
    </>
  ));
}

export function CloseIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ));
}

export function CheckIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <path d="M4.5 12.5l5 5L19.5 7" />
  ));
}

export function PlusIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ));
}

export function NoteIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M6 3.5h7.5L18 8v12.5H6Z" />
      <path d="M13.5 3.5V8H18" />
    </>
  ));
}

export function SelectionCountIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <path d="M12 3.5L19 12l-7 8.5L5 12Z" />
  ));
}

export function ChevronRightIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <path d="M9 5.5L15.5 12 9 18.5" />
  ));
}

export function ChevronDownIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <path d="M5.5 9L12 15.5 18.5 9" />
  ));
}

export function LibraryIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M4 20h16" />
      <path d="M6.5 20V9.5L9 8v12" />
      <path d="M11 20V6.5l2.5 1.5V20" />
      <path d="M15.5 20v-9L18 9.5V20" />
    </>
  ));
}

export function ListsIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M9 6.5h11.5M9 12h11.5M9 17.5h11.5" />
      <circle cx="5" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17.5" r="1.3" fill="currentColor" stroke="none" />
    </>
  ));
}

export function TagsIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M3.5 4.5h7L20 14l-7.5 7.5L3.5 11.5Z" />
      <circle cx="8" cy="9" r="1.4" />
    </>
  ));
}

export function MoreIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ));
}

export function LinkIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M10.5 13.5a4.2 4.2 0 0 0 6 0l2.8-2.8a4.24 4.24 0 0 0-6-6l-1.6 1.6" />
      <path d="M13.5 10.5a4.2 4.2 0 0 0-6 0l-2.8 2.8a4.24 4.24 0 0 0 6 6l1.6-1.6" />
    </>
  ));
}

/** Contact-sheet wordmark (design D-M9). Exported separately from the UI set. */
export function VaultMark({ size = 22, ...props }: IconProps) {
  const { width, height, ...rest } = props;
  return (
    <svg
      width={width ?? size}
      height={height ?? size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ink)"
      strokeWidth={1.8}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <rect x="1.5" y="1.5" width="9" height="9" fill="var(--accent)" />
      <rect x="13.5" y="1.5" width="9" height="9" />
      <rect x="1.5" y="13.5" width="9" height="9" />
      <rect x="13.5" y="13.5" width="9" height="9" />
    </svg>
  );
}

export function FullscreenIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </>
  ));
}

export function EyeIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ));
}

export function EyeOffIcon({ size = 16, ...props }: IconProps) {
  return base(size, props, (
    <>
      <path d="M2.5 12S6 5.5 12 5.5c2.2 0 4.2.8 5.8 1.9M21.5 12S18 18.5 12 18.5c-2.2 0-4.2-.8-5.8-1.9" />
      <path d="M4 4l16 16" />
    </>
  ));
}

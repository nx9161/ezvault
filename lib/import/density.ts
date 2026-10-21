// SPDX-License-Identifier: MIT
/**
 * lib/import/density.ts — render-density (PPI) plumbing for vector /
 * multi-page formats (Wave B1, parity rows 7 + 34).
 *
 * One source of truth for:
 *   - the global default density (projects.default_density, migration 0008;
 *     persisted via Project settings, shown in Settings + ImportDialog),
 *   - the per-photo override (photos.density, set in the Inspector),
 *   - validation/clamping shared by the API routes and the process
 *     pipeline, so a density that reaches sharp/pdf.js is always sane.
 *
 * Default: 300 PPI. Tropy renders PDFs at the density stored on the photo
 * (its own default is 300 for PDF conversion); v1's TIFF imports carried
 * the density embedded in the file, and 300 is the archival-scan standard
 * the owner's TIFF workflow assumes. The rasterizer's pixel cap (B5) still
 * bounds the output: density raises resolution only until MAX_INPUT_PIXELS.
 */

export const DEFAULT_RENDER_DENSITY = 300;

/** Accepted density range (PPI). Below 36 is unusable; above 1200 the
 *  50M-pixel cap makes higher values meaningless for our page sizes. */
export const MIN_RENDER_DENSITY = 36;
export const MAX_RENDER_DENSITY = 1200;

/** True when `v` is a usable density value (integer PPI in range). */
export function isValidDensity(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_RENDER_DENSITY &&
    v <= MAX_RENDER_DENSITY
  );
}

/** Clamp any numeric input into the accepted range; non-numbers → default. */
export function clampDensity(v: unknown, fallback: number = DEFAULT_RENDER_DENSITY): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(MAX_RENDER_DENSITY, Math.max(MIN_RENDER_DENSITY, Math.round(v)));
}

/**
 * Resolve the effective density for one photo: the per-photo override wins,
 * then the project default, then the global default. Mirrors how the
 * process pipeline and the export bake pick the value.
 */
export function resolveDensity(
  photoDensity: number | null | undefined,
  projectDefault: number | null | undefined,
): number {
  if (isValidDensity(photoDensity)) return photoDensity;
  if (isValidDensity(projectDefault)) return projectDefault;
  return DEFAULT_RENDER_DENSITY;
}

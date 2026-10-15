// SPDX-License-Identifier: MIT
// SHOULD-30 — partial-date validation for the metadata date widget.
// Minimum bar: YYYY, YYYY-MM, or full YYYY-MM-DD with real calendar checks.
// Full EDTF parsing stays backend/out of scope.

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Returns true for "", YYYY, YYYY-MM, or a calendar-valid YYYY-MM-DD.
 * Anything else (wrong shape, month 13, Feb 30, trailing junk) is false.
 */
export function isValidPartialDate(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  if (/^\d{4}$/.test(v)) return true;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return true;
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(v);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dim = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= dim;
}

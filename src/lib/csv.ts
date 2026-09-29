/**
 * One CSV cell, quoted. Cells that a spreadsheet would run as a formula
 * (starting with = + - @, tab or carriage return) get a leading apostrophe, so
 * an exported file can't carry formula injection.
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

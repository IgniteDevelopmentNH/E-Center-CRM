export interface CsvColumn<T> {
  key: keyof T & string;
  label: string;
}

/**
 * Escapes a value for CSV. Cells that begin with a formula character are
 * prefixed with an apostrophe so a spreadsheet cannot execute exported data.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join('; ') : String(value);
  if (typeof value === 'boolean') text = value ? 'Yes' : 'No';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Emits a UTF-8 BOM so Excel opens accented characters correctly. */
export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((column) => cell(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => cell(row[column.key])).join(','));
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

export function csvFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}

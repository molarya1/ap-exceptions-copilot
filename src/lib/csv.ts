// Minimal RFC 4180 CSV: quoted fields, embedded commas, quotes and newlines.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses a CSV with a header row into records. Keeps the 1-based file line of each row. */
export function readRecords(text: string): { line: number; values: Record<string, string> }[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((cells, i) => ({
    line: i + 2,
    values: Object.fromEntries(header.map((name, j) => [name, cells[j] ?? ''])),
  }));
}

function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map((v) => quote(String(v))).join(',')).join('\n') + '\n';
}

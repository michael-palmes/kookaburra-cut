/** Chart CSV/TSV: a hand-rolled, dependency-free reader and writer for the data grid's import, paste and export paths. Pure and `Intl`-free like `format.ts`, so a pasted table parses the same on every machine. The shape is the grid's: first row category labels (its leading cell is the corner and ignored), first column series names, numeric cells. */

/** One parsed series row: its name and one number per category. */
export interface ChartCsvSeries {
  name: string;
  values: number[];
}

export interface ChartCsvData {
  categories: string[];
  series: ChartCsvSeries[];
}

export interface ChartCsvError {
  error: string;
}

export type ChartCsvResult = ChartCsvData | ChartCsvError;

export function isChartCsvError(result: ChartCsvResult): result is ChartCsvError {
  return "error" in result;
}

/** Currency and grouping marks a spreadsheet copy carries into a numeric cell; stripped before parsing so "$1,234" reads as 1234. */
const NUMERIC_NOISE = /[$£€¥%,\s]/g;

/** Split a delimited table into raw cells: quotes (`""` escapes a quote), embedded commas and newlines, and CRLF/CR/LF line endings all survive. Tab-delimited (the Numbers/Excel clipboard shape) is detected from the first unquoted delimiter. A trailing newline adds no row. */
export function parseDelimitedRows(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(body);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    started = true;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      continue;
    }
    if (ch === "\r") {
      if (body[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    cell += ch;
  }
  if (started || cell !== "" || row.length > 0) endRow();
  return rows;
}

/** Tab wins when it appears before any comma outside quotes: pasted spreadsheet cells are tab-delimited and routinely contain commas. */
function detectDelimiter(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "\t") return "\t";
    if (ch === ",") return ",";
    if (ch === "\n" || ch === "\r") break;
  }
  return ",";
}

/** A grid cell's number: empty reads as 0, grouping and currency marks are stripped, and accountancy parentheses read as negative. Null means "not a number", which the grid reports per cell rather than silently zeroing. */
export function parseChartNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const negative = /^\(.*\)$/.test(trimmed);
  const body = negative ? trimmed.slice(1, -1) : trimmed;
  const cleaned = body.replace(NUMERIC_NOISE, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Spreadsheet cell reference for an error message: row 2, column 3 reads as C2 (the header row is row 1). */
function cellRef(rowIndex: number, columnIndex: number): string {
  let n = columnIndex;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${name}${rowIndex + 1}`;
}

/** Parse a CSV/TSV table into chart data: first row categories (leading corner cell ignored), first column series names, everything else numeric. Short rows pad with 0, empty cells read as 0, and the first non-numeric cell fails the whole import with its reference. */
export function parseChartCsv(text: string): ChartCsvResult {
  const rows = parseDelimitedRows(text).filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) return { error: "That file is empty." };
  const width = Math.max(...rows.map((row) => row.length)) - 1;
  const header = rows[0];
  const categories: string[] = [];
  for (let c = 0; c < width; c++) categories.push((header[c + 1] ?? "").trim());
  // Trailing columns a spreadsheet padded in (no label AND no data anywhere) drop.
  while (
    categories.length > 0 &&
    categories[categories.length - 1] === "" &&
    rows.every((row) => (row[categories.length] ?? "").trim() === "")
  ) {
    categories.pop();
  }
  if (categories.length === 0) {
    return {
      error: "The first row needs a category label per column (the first cell is ignored).",
    };
  }
  if (rows.length < 2) return { error: "Add at least one series row under the category row." };
  const series: ChartCsvSeries[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const values: number[] = [];
    for (let c = 0; c < categories.length; c++) {
      const raw = cells[c + 1] ?? "";
      const value = parseChartNumber(raw);
      if (value === null) {
        return { error: `${cellRef(r, c + 1)} is not a number: "${raw.trim()}"` };
      }
      values.push(value);
    }
    series.push({ name: cells[0].trim() || `Series ${r}`, values });
  }
  return { categories: categories.map((c, i) => c || `Category ${i + 1}`), series };
}

const needsQuoting = (cell: string): boolean => /[",\r\n]/.test(cell);

const quote = (cell: string): string =>
  needsQuoting(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;

/** The inverse of `parseChartCsv`: a comma-delimited table with an empty corner cell, LF line endings and a trailing newline. */
export function serialiseChartCsv(data: ChartCsvData): string {
  const lines = [["", ...data.categories].map(quote).join(",")];
  for (const s of data.series) {
    lines.push([quote(s.name), ...s.values.map((v) => String(v))].join(","));
  }
  return `${lines.join("\n")}\n`;
}

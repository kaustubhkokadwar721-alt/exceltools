// Extract native Excel Tables (ListObjects) straight from the .xlsx zip, since
// SheetJS community does not surface them on parse. The table XML is small and
// flat, so targeted regex is enough (and works in a Web Worker, which has no
// DOMParser). Grid slicing (values for the table's range) is done by the caller
// with SheetJS; this module only produces the metadata + mapping.
import { unzipSync } from 'fflate';

export interface TableMeta {
  name: string;
  sheetName: string;
  ref: string; // A1 range
  columns: string[];
}

const dec = new TextDecoder();
const text = (files: Record<string, Uint8Array>, key: string): string | undefined =>
  files[key] ? dec.decode(files[key]) : undefined;

const attr = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Parse a single xl/tables/tableN.xml into name/ref/columns. Pure + testable. */
export function parseTableXml(xml: string): { name: string; ref: string; columns: string[] } | null {
  const head = xml.match(/<table\b[^>]*>/)?.[0];
  if (!head) return null;
  const ref = attr(head, 'ref');
  if (!ref) return null;
  const name = attr(head, 'displayName') || attr(head, 'name') || 'Table';
  const columns = [...xml.matchAll(/<tableColumn\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
  return { name: unescapeXml(name), ref, columns };
}

/** Map worksheet file (e.g. "sheet1.xml") → sheet display name via workbook rels. */
function sheetFileToName(files: Record<string, Uint8Array>): Record<string, string> {
  const wb = text(files, 'xl/workbook.xml');
  const rels = text(files, 'xl/_rels/workbook.xml.rels');
  const out: Record<string, string> = {};
  if (!wb || !rels) return out;
  const relTarget: Record<string, string> = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const tgt = attr(m[0], 'Target');
    if (id && tgt) relTarget[id] = tgt.replace(/^\/?xl\//, '').replace(/^\.\//, '');
  }
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
    if (!name || !rid) continue;
    const target = relTarget[rid]; // e.g. "worksheets/sheet1.xml"
    if (target) out[target.replace(/^worksheets\//, '')] = unescapeXml(name);
  }
  return out;
}

/** Extract every table's metadata from an unzipped xlsx. */
export function extractTableMeta(files: Record<string, Uint8Array>): TableMeta[] {
  const nameOf = sheetFileToName(files);
  const metas: TableMeta[] = [];

  // Each worksheet's _rels associates it with its tables.
  for (const key of Object.keys(files)) {
    const m = key.match(/^xl\/worksheets\/_rels\/(sheet\d+\.xml)\.rels$/);
    if (!m) continue;
    const sheetFile = m[1];
    const sheetName = nameOf[sheetFile] || sheetFile.replace(/\.xml$/, '');
    const relsXml = text(files, key)!;
    for (const r of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tgt = attr(r[0], 'Target');
      if (!tgt || !/tables\/table\d+\.xml$/.test(tgt)) continue;
      const tableKey = 'xl/' + tgt.replace(/^\.\.\//, '').replace(/^\/?xl\//, '');
      const tXml = text(files, tableKey);
      if (!tXml) continue;
      const parsed = parseTableXml(tXml);
      if (parsed) metas.push({ name: parsed.name, sheetName, ref: parsed.ref, columns: parsed.columns });
    }
  }
  return metas;
}

/** Unzip an .xlsx buffer and extract its table metadata. */
export function extractTables(buffer: ArrayBuffer): TableMeta[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return []; // not a zip (e.g. .csv) — no tables
  }
  return extractTableMeta(files);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

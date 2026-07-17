// Bundle multiple output files into a single .zip so tools that emit many files
// (Split, and Merge-to-CSVs) trigger one download instead of dozens of prompts.
import { zipSync, type Zippable } from 'fflate';

export interface ZipEntry {
  name: string; // file name inside the archive
  data: Uint8Array;
}

export function makeZip(entries: ZipEntry[]): Blob {
  const files: Zippable = {};
  const used = new Set<string>();
  for (const e of entries) {
    files[uniqueName(e.name, used)] = e.data;
  }
  // level 6 is a good size/speed balance; spreadsheets compress well.
  const bytes = zipSync(files, { level: 6 });
  // Cast: fflate returns Uint8Array<ArrayBufferLike>; BlobPart wants ArrayBuffer-backed.
  return new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  let n = 2;
  let candidate = `${base}_${n}${ext}`;
  while (used.has(candidate)) candidate = `${base}_${++n}${ext}`;
  used.add(candidate);
  return candidate;
}

import { describe, it, expect } from 'vitest';
import {
  validateFile,
  extensionOf,
  formatBytes,
  SOFT_SIZE_WARN_BYTES,
  HARD_SIZE_LIMIT_BYTES,
} from '../../src/core/validation';

const file = (name: string, size: number): File =>
  // A sparse File whose reported size we control (content length would be huge
  // otherwise); only .name and .size are read by validateFile.
  Object.defineProperty(new File(['x'], name), 'size', { value: size });

describe('extensionOf', () => {
  it('returns the lowercased extension', () => {
    expect(extensionOf('Report.XLSX')).toBe('xlsx');
    expect(extensionOf('data.tar.gz')).toBe('gz');
  });
  it('returns empty string when there is no extension', () => {
    expect(extensionOf('README')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('validateFile', () => {
  it('accepts a supported, reasonably-sized file', () => {
    expect(validateFile(file('data.xlsx', 1000))).toEqual({ ok: true });
  });

  it('rejects an unsupported extension', () => {
    const r = validateFile(file('notes.pdf', 1000));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('.pdf');
  });

  it('rejects a file with no extension', () => {
    expect(validateFile(file('data', 1000)).ok).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(validateFile(file('data.csv', 0)).ok).toBe(false);
  });

  it('rejects a file above the hard limit', () => {
    expect(validateFile(file('big.xlsx', HARD_SIZE_LIMIT_BYTES + 1)).ok).toBe(false);
  });

  it('accepts but warns above the soft limit', () => {
    const r = validateFile(file('big.xlsx', SOFT_SIZE_WARN_BYTES + 1));
    expect(r.ok).toBe(true);
    expect(r.warning).toBeDefined();
  });
});

import { describe, it, expect } from 'vitest';
import { unzipSync, strToU8, strFromU8 } from 'fflate';
import { makeZip } from '../../src/core/zip';

describe('makeZip', () => {
  it('produces a zip containing the given entries', async () => {
    const blob = makeZip([
      { name: 'a.txt', data: strToU8('hello') },
      { name: 'b.txt', data: strToU8('world') },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'b.txt']);
    expect(strFromU8(files['a.txt'])).toBe('hello');
  });

  it('de-duplicates colliding entry names', async () => {
    const blob = makeZip([
      { name: 'x.csv', data: strToU8('1') },
      { name: 'x.csv', data: strToU8('2') },
    ]);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['x.csv', 'x_2.csv']);
  });
});

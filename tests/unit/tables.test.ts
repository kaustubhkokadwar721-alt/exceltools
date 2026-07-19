import { describe, it, expect } from 'vitest';
import { parseTableXml, extractTableMeta } from '../../src/core/tables';

const enc = (s: string) => new TextEncoder().encode(s);

const TABLE_XML =
  '<table xmlns="x" id="1" name="Sales" displayName="Sales" ref="C4:E6" totalsRowShown="0">' +
  '<tableColumns count="3"><tableColumn id="1" name="Order"/><tableColumn id="2" name="Amount"/>' +
  '<tableColumn id="3" name="City &amp; Region"/></tableColumns></table>';

describe('parseTableXml', () => {
  it('reads name, ref and columns (with entity unescape)', () => {
    const t = parseTableXml(TABLE_XML)!;
    expect(t.name).toBe('Sales');
    expect(t.ref).toBe('C4:E6');
    expect(t.columns).toEqual(['Order', 'Amount', 'City & Region']);
  });
  it('returns null without a ref', () => {
    expect(parseTableXml('<table name="x"></table>')).toBeNull();
  });
});

describe('extractTableMeta', () => {
  it('maps a table to its sheet via the rels chain', () => {
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml': enc('<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': enc(
        '<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/_rels/sheet1.xml.rels': enc(
        '<Relationships><Relationship Id="rId1" Type="http://x/table" Target="../tables/table1.xml"/></Relationships>',
      ),
      'xl/tables/table1.xml': enc(TABLE_XML),
    };
    const metas = extractTableMeta(files);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ name: 'Sales', sheetName: 'Data', ref: 'C4:E6' });
    expect(metas[0].columns).toEqual(['Order', 'Amount', 'City & Region']);
  });
});

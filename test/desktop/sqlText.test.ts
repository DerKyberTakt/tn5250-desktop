import { describe, expect, it } from 'vitest';
import { alignedTable, delimitedTable, markdownTable } from '../../src/desktop/sqlText';

const columns = [
  { name: 'ID', type: 'DECIMAL', length: 5, scale: 0, nullable: false },
  { name: 'NAME', label: 'Customer name', type: 'VARCHAR', length: 30, scale: 0, nullable: true },
];
const rows = [
  ['1', 'Acme, Inc.'],
  ['12345', null],
  ['7', 'Two\nlines'],
];

describe('result set as text', () => {
  it('aligned: numbers right, text left, NULL as -, line breaks shown', () => {
    expect(alignedTable(columns, rows)).toBe(['   ID  Customer name', '-----  -------------', '    1  Acme, Inc.', '12345  -', '    7  Two⏎lines', ''].join('\r\n'));
  });

  it('markdown: pipe table with the alignment rule', () => {
    expect(markdownTable(columns, rows)).toBe(['| ID | Customer name |', '| ---: | --- |', '| 1 | Acme, Inc. |', '| 12345 |  |', '| 7 | Two<br>lines |', ''].join('\r\n'));
  });

  it('csv quotes what needs it, tsv does not quote commas', () => {
    expect(delimitedTable(columns, rows, ',')).toBe(['ID,Customer name', '1,"Acme, Inc."', '12345,', '7,"Two\nlines"', ''].join('\r\n'));
    expect(delimitedTable(columns, rows, '\t')).toBe(['ID\tCustomer name', '1\tAcme, Inc.', '12345\t', '7\t"Two\nlines"', ''].join('\r\n'));
  });
});

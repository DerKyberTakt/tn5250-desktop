import { describe, expect, it } from 'vitest';
import { csvField, parseCsv, serializeCsv, sniffDelimiter } from '../../src/desktop/csvGrid';

describe('CSV parsing', () => {
  it('sniffs the delimiter from the first lines', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(sniffDelimiter('a|b\n1|2\n')).toBe('|');
    expect(sniffDelimiter('"x, y";1\n"z";2\n')).toBe(';'); // the comma inside quotes does not count
  });

  it('honours quotes, doubled quotes, line breaks inside fields, CRLF and a trailing line end', () => {
    const { delimiter, rows } = parseCsv('id,name\r\n1,"Acme, Inc."\r\n2,"say ""hi"""\r\n3,"two\nlines"\r\n');
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['id', 'name'],
      ['1', 'Acme, Inc.'],
      ['2', 'say "hi"'],
      ['3', 'two\nlines'],
    ]);
  });

  it('keeps empty fields and ragged rows', () => {
    expect(parseCsv('a,,c\n1\n', ',').rows).toEqual([['a', '', 'c'], ['1']]);
  });

  it('writes the rows back as it read them: quotes only where needed, the delimiter and line ends kept', () => {
    const text = 'id;name\r\n1;"Acme; Inc."\r\n2;"say ""hi"" now"\r\n3;plain\r\n';
    expect(serializeCsv(parseCsv(text), '\r\n')).toBe(text);
    expect(csvField(' edge ', ',')).toBe('" edge "');
    expect(csvField('two\nlines', ',')).toBe('"two\nlines"');
    expect(csvField('x', '\t')).toBe('x');
  });
});

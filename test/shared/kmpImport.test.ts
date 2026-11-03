import { describe, expect, it } from 'vitest';
import { importKmp } from '../../src/shared/kmpImport';

describe('importKmp', () => {
  it('imports modifier + Java key code entries from the KeyRemap section', () => {
    const text = [
      '[KeyRemap]',
      'S10=[fldext]',
      'XF:[textvisualdisp]=[textvisualdisp]',
      'keyVersion=2',
      'sessionType=2',
      'autoApply=false',
      'codePage=037',
      'B107=[fldext]',
      'C112=[pf13]',
      'B27=[attn]',
      'B999=[enter]',
      'B10=[unknownfn]',
      'B35=[eof]',
      'C35=[eraseeof]',
    ].join('\n');
    const r = importKmp(text);
    expect(r.keymap).toEqual({
      'Shift+Enter': 'fieldExit',
      NumpadAdd: 'fieldExit',
      'Ctrl+F1': 'pf13',
      Escape: 'attn',
      End: 'endOfField',
      'Ctrl+End': 'eraseEof',
    });
    expect(r.skipped).toEqual(['B999=[enter]', 'B10=[unknownfn]']);
  });

  it('knows the other ACS spellings and the 0.1.5 cursor/edit functions', () => {
    const text = ['[KeyRemap]', 'B107=[field+]', 'B109=[field-]', 'B155=[instog]', 'A38=[fastup]', 'A40=[fastdown]', 'C127=[worddel]', 'B35=[bof]', 'C123=[test]', 'A8=[rcdbacksp]'].join('\n');
    expect(importKmp(text).keymap).toEqual({
      NumpadAdd: 'fieldPlus',
      NumpadSubtract: 'fieldMinus',
      Insert: 'insert',
      'Alt+ArrowUp': 'fastUp',
      'Alt+ArrowDown': 'fastDown',
      'Ctrl+Delete': 'deleteWord',
      End: 'beginningOfField',
      'Ctrl+F12': 'testRequest',
      'Alt+Backspace': 'recordBackspace',
    });
  });

  it('ignores lines outside [KeyRemap]', () => {
    expect(importKmp('[Other]\nB10=[enter]\n').keymap).toEqual({});
  });
});

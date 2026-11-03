import { describe, expect, it } from 'vitest';
import { classifyPcCommand, decidePcCommand } from '../../src/shared/pcCommand';

describe('PC command policy (STRPCCMD)', () => {
  it('tells links from commands', () => {
    expect(classifyPcCommand('START http://pub400.com:8080/wv/x?key=1')).toEqual({ kind: 'link', url: 'http://pub400.com:8080/wv/x?key=1' });
    expect(classifyPcCommand('start "" https://pub400.com/')).toEqual({ kind: 'link', url: 'https://pub400.com/' });
    expect(classifyPcCommand('START /max "Title" "https://pub400.com/a"')).toEqual({ kind: 'link', url: 'https://pub400.com/a' });
    // A URL with a space is not a link; it goes through the command path (and its prompt).
    expect(classifyPcCommand('START "https://pub400.com/a b"').kind).toBe('command');
    expect(classifyPcCommand('  https://pub400.com/x  ')).toEqual({ kind: 'link', url: 'https://pub400.com/x' });
    expect(classifyPcCommand('NOTEPAD C:\\TEMP\\A.TXT')).toEqual({ kind: 'command', command: 'NOTEPAD C:\\TEMP\\A.TXT' });
    expect(classifyPcCommand('start notepad.exe')).toEqual({ kind: 'command', command: 'start notepad.exe' });
    expect(classifyPcCommand('start http://pub400.com/ && del x')).toEqual({ kind: 'command', command: 'start http://pub400.com/ && del x' });
    expect(classifyPcCommand('START file:///C:/x.txt')).toEqual({ kind: 'command', command: 'START file:///C:/x.txt' });
  });

  it('applies the policy', () => {
    const link = classifyPcCommand('START https://pub400.com/');
    const cmd = classifyPcCommand('NOTEPAD');
    expect(decidePcCommand('links', link)).toBe('open');
    expect(decidePcCommand('links', cmd)).toBe('ask');
    expect(decidePcCommand('ask', link)).toBe('ask');
    expect(decidePcCommand('ask', cmd)).toBe('ask');
    expect(decidePcCommand('all', link)).toBe('open');
    expect(decidePcCommand('all', cmd)).toBe('run');
    expect(decidePcCommand('off', link)).toBe('ignore');
    expect(decidePcCommand('off', cmd)).toBe('ignore');
  });
});

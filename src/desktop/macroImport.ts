import { describeStep, type Macro } from '../shared/macros';

/** A name from a file somebody else wrote: one line, no control or bidi-override characters, at most 120 characters. */
export function cleanName(t: string): string {
  return Array.from(t.slice(0, 120), (c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) ? ' ' : c;
  }).join('');
}

export interface ImportPreview {
  title: string;
  /** Names, keys, step counts and which saved macros are replaced; at most 15 lines. */
  detail: string;
  /** What the dialog says above the detail (the refused keys, when there are any). */
  note: string;
}

/** What the user must see before an imported macros file is stored. */
export function macroImportPreview(incoming: Macro[], saved: Macro[], refused: string[]): ImportPreview {
  const lines = incoming.map((m) => {
    const replaces = saved.find((o) => o.id === m.id);
    const steps = m.steps.slice(0, 3).map(describeStep).join('; ') + (m.steps.length > 3 ? '; ...' : '');
    return `${replaces ? `REPLACES "${cleanName(replaces.name)}" with` : 'adds'} "${cleanName(m.name)}"${m.key ? ` on ${cleanName(m.key)}` : ''}: ${m.steps.length} step${m.steps.length === 1 ? '' : 's'} (${cleanName(steps)})`;
  });
  const n = incoming.length;
  return {
    title: `Import ${n} macro${n === 1 ? '' : 's'}?`,
    detail: lines.slice(0, 15).join('\n') + (lines.length > 15 ? `\n... and ${lines.length - 15} more` : ''),
    note: refused.length ? `Keys refused (they would shadow ordinary keys), the macros come in without a key: ${refused.map(cleanName).join(', ')}.` : 'Nothing is stored until you press Import.',
  };
}

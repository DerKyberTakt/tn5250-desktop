/**
 * What the emulator does with a PC command the host sends through STRPCCMD (PC Organizer).
 * - links: http(s) links open in the default browser at once, other commands ask first
 * - ask: every command, links included, asks first
 * - all: everything runs without asking (what PC Organizer and tn5250j do)
 * - off: the host's own "PCO.EXE is not active" screen is shown, nothing runs
 */
export type PcCommandPolicy = 'links' | 'ask' | 'all' | 'off';

export const PC_COMMAND_POLICIES: readonly PcCommandPolicy[] = ['links', 'ask', 'all', 'off'];

export type PcCommandKind = { kind: 'link'; url: string } | { kind: 'command'; command: string };

export type PcCommandDecision = 'open' | 'run' | 'ask' | 'ignore';

/**
 * Tells a link apart from a command. STRPCCMD PCCMD('START http://...') is the usual way
 * host programs open a browser; a bare URL and START with a window title or switches
 * (START "" /max https://...) count as links too.
 */
export function classifyPcCommand(command: string): PcCommandKind {
  const text = command.trim();
  const m = /^(?:start\s+(?:\/\w+\s+)*(?:"[^"]*"\s+)?)?["']?(https?:\/\/[^\s"']+)["']?$/i.exec(text);
  if (m) return { kind: 'link', url: m[1] as string };
  return { kind: 'command', command: text };
}

export function decidePcCommand(policy: PcCommandPolicy, kind: PcCommandKind): PcCommandDecision {
  if (policy === 'off') return 'ignore';
  if (kind.kind === 'link') return policy === 'ask' ? 'ask' : 'open';
  return policy === 'all' ? 'run' : 'ask';
}

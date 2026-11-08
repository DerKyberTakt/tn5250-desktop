import { describe, expect, it } from 'vitest';
import { fileName, importMessage, importRows, mergeImported, readProfiles, unreadableNote } from '../../src/desktop/importConnections';

const hod = (lines: string[]): string => ['[Host On-Demand Session File][4.00]', '[HostPrintTerminal]', '[Terminal]', ...lines].join('\r\n');

describe('readProfiles', () => {
  it('keeps the 5250 display sessions in file order, drops other profiles quietly and counts unreadable files', async () => {
    const files: Record<string, string> = {
      'C:\\acs\\Prod.hod': hod(['sessionType=2', 'host=pub400.com', 'port=992', 'SSL=true']),
      'C:\\acs\\Printer.hod': hod(['sessionType=6']),
      '/home/me/Dev.hod': hod(['sessionType=2', 'host=10.020.3.4']),
    };
    const read = async (p: string): Promise<string> => {
      if (p === 'C:\\acs\\Broken.hod') throw new Error('EACCES');
      return files[p] as string;
    };
    const found = await readProfiles([...Object.keys(files), 'C:\\acs\\Broken.hod'], read);
    expect(found.sessions.map((s) => s.session.name)).toEqual(['Prod', 'Dev']);
    expect(found.sessions[1]?.notes).toEqual(['address 10.020.3.4 read as 10.20.3.4, as ACS does']);
    expect(found.unreadable).toBe(1);
  });

  it('names the connection after the file, whatever the path separator', () => {
    expect(fileName('C:\\Users\\me\\Documents\\IBM\\iAccessClient\\Emulator\\Prod - Release.hod')).toBe('Prod - Release.hod');
    expect(fileName('/home/me/Dev.hod')).toBe('Dev.hod');
  });
});

describe('importRows', () => {
  it('describes each session and flags the ones already saved', () => {
    const rows = importRows(
      [
        { session: { name: 'Prod', host: 'pub400.com', port: 992, tls: true, screenSize: '27x132', codePage: 273, deviceName: 'DEV*', signonUser: 'DEMOUSER' }, notes: ['backup hosts left out'] },
        { session: { name: '', host: 'dev.example.com' }, notes: [] },
      ],
      [{ name: 'prod', host: 'PUB400.com' }],
    );
    expect(rows).toEqual([
      { label: 'Prod', detail: 'pub400.com:992 TLS, 27x132, CCSID 273, device DEV*, user DEMOUSER, backup hosts left out', replaces: true },
      { label: 'dev.example.com', detail: 'dev.example.com', replaces: false },
    ]);
  });
});

describe('importMessage', () => {
  it('counts what was imported, replaced and unreadable', () => {
    const merged = mergeImported([{ name: 'Prod', host: 'h' }], [{ name: 'Prod', host: 'h', port: 992 }, { name: 'Dev', host: 'd' }]);
    expect(importMessage(merged, 0)).toBe('2 connections imported (1 replaced saved ones).');
    expect(importMessage(mergeImported([], [{ name: 'Dev', host: 'd' }]), 2)).toBe('1 connection imported. 2 files could not be read.');
    expect(unreadableNote(1)).toBe(' 1 file could not be read.');
    expect(unreadableNote(0)).toBe('');
  });
});

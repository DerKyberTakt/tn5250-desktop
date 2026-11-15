import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hodColorPair, hodProfileName, importHod, normalizeIpv4, parseIni } from '../../src/shared/hodImport';

const fixture = readFileSync(join(__dirname, '..', 'fixtures', 'acs-display.hod'), 'utf8');

const hod = (terminal: string[], extra: string[] = []): string =>
  ['[Host On-Demand Session File][4.00]', '[HostPrintTerminal]', '[Terminal]', ...terminal, ...extra].join('\r\n');

describe('parseIni', () => {
  it('reads sections and keys case-insensitively, splits at the first =, and skips a BOM', () => {
    const ini = parseIni('\uFEFF[Host On-Demand Session File][4.00]\r\n[Terminal]\r\nHost = a=b \r\n.,=.,\r\n[Empty]\r\n');
    expect(ini.get('terminal')?.get('host')).toBe('a=b');
    expect(ini.get('terminal')?.get('.,')).toBe('.,');
    expect(ini.has('host on-demand session file')).toBe(true);
    expect(ini.get('empty')?.size).toBe(0);
  });
});

describe('hodProfileName', () => {
  it('drops the folder and the .hod extension', () => {
    expect(hodProfileName('C:\\Users\\me\\Documents\\IBM\\iAccessClient\\Emulator\\Prod - Release.hod')).toBe('Prod - Release');
    expect(hodProfileName('/home/me/IBM/Dev.HOD')).toBe('Dev');
  });
});

describe('hodColorPair', () => {
  it('reads the text RGB from bits 0-23 and the background RGB from bits 32-55', () => {
    // ACS shows this one as black text on a #CC9900 background.
    expect(hodColorPair('57589120528023552')).toEqual({ text: '#000000', background: '#cc9900' }); // 0x00CC9900_00000000
    expect(hodColorPair('13408512')).toEqual({ text: '#cc9900', background: '#000000' }); // 0x00000000_00CC9900
  });

  it('gives nothing for special values (top byte set), empty or malformed text', () => {
    expect(hodColorPair('-936748722493063168')).toBeUndefined(); // 0xF3000000_00000000
    expect(hodColorPair('')).toBeUndefined();
    expect(hodColorPair('FFFFFF')).toBeUndefined();
    expect(hodColorPair('12.5')).toBeUndefined();
  });
});

describe('normalizeIpv4', () => {
  it('reads every part of an IPv4 address in decimal, as ACS does', () => {
    expect(normalizeIpv4('10.020.3.004')).toBe('10.20.3.4');
    expect(normalizeIpv4('10.20.3.4')).toBe('10.20.3.4');
  });

  it('leaves host names and anything that is not an IPv4 address alone', () => {
    expect(normalizeIpv4('myibmi.example.com')).toBe('myibmi.example.com');
    expect(normalizeIpv4('10.300.3.4')).toBe('10.300.3.4');
    expect(normalizeIpv4('::1')).toBe('::1');
  });
});

describe('importHod', () => {
  it('imports a 5250 display profile written by ACS', () => {
    const r = importHod(fixture, 'Pub400.hod');
    expect(r).toEqual({
      ok: true,
      session: {
        name: 'Pub400',
        host: 'pub400.com',
        port: 992,
        tls: true,
        screenSize: '27x132',
        codePage: 273,
        deviceName: 'DEV*=',
        signonUser: 'DEMOUSER',
        autoConnect: true,
        autoReconnect: true,
        keepAlive: false,
        connectTimeoutSeconds: 0,
        inactivityTimeoutMinutes: 0,
        columnSeparators: 'dot',
        colorGreen: '#cc9900',
      },
      notes: [],
    });
  });

  it('carries the display, paste, hotspot, mouse wheel and sound options ACS shares with the emulator', () => {
    const terminal = [
      'sessionType=2',
      'host=h',
      'ruleLine=true',
      'ruleLineStyle=vertical',
      'ruleLineFollows=false',
      'columnSeparator=line',
      'OIAVisible=false',
      'blockCursor=false',
      'autoFontSize=false',
      'fontStyle=1',
      'pasteFieldWrap=false',
      'pasteStopAtProtectedLine=false',
      'pasteMoveCursor=false',
      'pasteTabSpaces=3',
      'pasteTabColumns=8',
      'showPFnn=enablePFNN',
      'showFPnn=disableFPNN',
      'showFnn=enableFNN',
      'shownn=disableNN',
      'showURLsMode=underlineURLs',
      'showEnterAtCursor=true',
      'mouseWheelEnabled=true',
      'mouseWheelUp=[pageup]',
      'mouseWheelDown=[pagedn]',
      'DISABLE_SESSION_TYPE_AHEAD=true',
      'soundAlarm=true',
      'soundMute=false',
    ];
    const r = importHod(hod(terminal, ['[BlinkRemap]', 'blinkCursor=false']), 'Options.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({
      ruleLine: true,
      ruleLineStyle: 'vertical',
      ruleLineFollowsCursor: false,
      columnSeparators: 'line',
      showStatusLine: false,
      cursorStyle: 'underline',
      cursorBlink: false,
      autoFit: false,
      fontStyle: 'bold',
      pasteFieldWrap: false,
      pasteStopAtProtected: false,
      pasteMoveCursorToEnd: false,
      pasteTabSpaces: 3,
      pasteTabColumns: 8,
      hotspotsPF: true,
      hotspotsFP: false,
      hotspotsF: true,
      hotspotsNumber: false,
      hotspotsUrl: true,
      enterAtCursorClick: true,
      mouseWheelPaging: true,
      typeAhead: false,
      alarm: true,
    });
  });

  it('mutes the alarm when ACS mutes all sounds, and leaves unknown values to the Defaults', () => {
    const r = importHod(hod(['sessionType=2', 'host=h', 'soundAlarm=true', 'soundMute=true', 'columnSeparator=dashes', 'ruleLineStyle=box', 'mouseWheelEnabled=true', 'mouseWheelUp=[up]']), 'Mute.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.alarm).toBe(false);
    for (const key of ['columnSeparators', 'ruleLineStyle', 'mouseWheelPaging']) expect(r.session).not.toHaveProperty(key);
  });

  it('reads the tab character choice for paste: 1 tab stops, 2 spaces, 3 next field', () => {
    const modes = ['1', '2', '3'].map((v) => {
      const r = importHod(hod(['sessionType=2', 'host=h', `pasteTabOptions=${v}`]), 'Tabs.hod');
      return r.ok ? r.session.pasteTabMode : undefined;
    });
    expect(modes).toEqual(['tabStop', 'spaces', 'nextField']);
    for (const v of ['0', '4', 'spaces']) {
      const r = importHod(hod(['sessionType=2', 'host=h', `pasteTabOptions=${v}`]), 'Tabs.hod');
      if (!r.ok) throw new Error(r.reason);
      expect(r.session).not.toHaveProperty('pasteTabMode');
    }
  });

  it('turns the key click on only for the normal clicker: off, errors only and muted leave it off', () => {
    const click = (terminal: string[]): boolean | undefined => {
      const r = importHod(hod(['sessionType=2', 'host=h', ...terminal]), 'Click.hod');
      if (!r.ok) throw new Error(r.reason);
      return r.session.keyClick;
    };
    expect(click(['soundClicker=normal'])).toBe(true);
    expect(click(['soundClicker=off'])).toBe(false);
    expect(click(['soundClicker=normal', 'soundMute=true'])).toBe(false);
    expect(click(['soundClicker=error'])).toBe(false);
    expect(click([])).toBeUndefined();
  });

  it('takes the watermark only when the profile shows one', () => {
    const shown = importHod(hod(['sessionType=2', 'host=h', 'Watermark=true', 'haveTextAsWatermark=true', 'WatermarkText=PROD', 'WatermarkOpacity=0.3', 'watermarkPosition=tile']), 'W.hod');
    if (!shown.ok) throw new Error(shown.reason);
    expect(shown.session).toMatchObject({ watermarkType: 'text', watermarkText: 'PROD', watermarkOpacity: 0.3, watermarkPosition: 'tile' });
    const hidden = importHod(hod(['sessionType=2', 'host=h', 'Watermark=false', 'WatermarkText=DEV']), 'W.hod');
    if (!hidden.ok) throw new Error(hidden.reason);
    expect(hidden.session).not.toHaveProperty('watermarkText');
  });

  it('reads the keyboard map stored in the profile', () => {
    const r = importHod(hod(['sessionType=2', 'host=h'], ['[KeyRemap]', 'keyVersion=2', 'S10=[fldext]', 'D86=|80']), 'Keys.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.keymap).toEqual({ 'Shift+Enter': 'fieldExit' });
  });

  it('carries the field colors the profile remaps to another text color', () => {
    const remap = ['[ColorRemap]', 'fWT=16777215', 'fBL=255', 'fRD=', 'fPK=-936748722493063168', 'sBG=', 'actF=1'];
    const r = importHod(hod(['sessionType=2', 'host=h'], remap), 'Colors.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({ colorWhite: '#ffffff', colorBlue: '#0000ff' });
    for (const key of ['colorRed', 'colorPink', 'colorBackground', 'colorActiveField']) expect(r.session).not.toHaveProperty(key);
    expect(r.notes).toEqual([]);
  });

  it('shows black text on a colored block as text in the block color, with a note', () => {
    const r = importHod(hod(['sessionType=2', 'host=h'], ['[ColorRemap]', 'fGN=57589120528023552']), 'Prod.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.colorGreen).toBe('#cc9900');
    expect(r.notes).toEqual(['green shown as #cc9900 text (ACS: black on #cc9900)']);
  });

  it('keeps the text color of colored text on a colored block, with a note', () => {
    // 0x000000FF_00FFFFFF: white text on a blue block.
    const r = importHod(hod(['sessionType=2', 'host=h'], ['[ColorRemap]', 'fWT=1095233437695']), 'Blue.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.colorWhite).toBe('#ffffff');
    expect(r.notes).toEqual(['white shown without its #0000ff block']);
  });

  it('carries the screen background, status line, crosshair ruler and column separator colors', () => {
    const remap = [
      '[ColorRemap]',
      'sBG=20587255718477824', // 0x00492400_00000000: the color is in the background half
      'oSI=32896', // 0x00000000_00008080: the color is in the text half
      'oII=16776960',
      'oAI=16711935',
      'oEI=16711680',
      'oOB=280375465082880', // 0x0000FF00_00000000
      'cRC=10526720',
      'cCS=255',
    ];
    const r = importHod(hod(['sessionType=2', 'host=h'], remap), 'Screen.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({
      colorBackground: '#492400',
      colorOiaStatus: '#008080',
      colorOiaInfo: '#ffff00',
      colorOiaAttention: '#ff00ff',
      colorOiaError: '#ff0000',
      colorOiaBackground: '#00ff00',
      colorRuleLine: '#a0a000',
      colorColumnSeparator: '#0000ff',
    });
    expect(r.notes).toEqual([]);
  });

  it('tints the active field only when ACS highlights it, and notes the text color left out', () => {
    // 0x00FFA200_00000080: dark blue text on orange.
    const on = importHod(hod(['sessionType=2', 'host=h'], ['[ColorRemap]', 'actF=71954239944917120', 'actFieldHilite=true']), 'Active.hod');
    if (!on.ok) throw new Error(on.reason);
    expect(on.session.colorActiveField).toBe('#ffa200');
    expect(on.notes).toEqual(['active field shown without its #000080 text']);
    const off = importHod(hod(['sessionType=2', 'host=h'], ['[ColorRemap]', 'actF=71954239944917120', 'actFieldHilite=false']), 'Active.hod');
    if (!off.ok) throw new Error(off.reason);
    expect(off.session).not.toHaveProperty('colorActiveField');
    expect(off.notes).toEqual([]);
  });

  it('treats a field color block in the screen background color as no block', () => {
    // White text on brown (0x00492400_00FFFFFF) on a brown screen.
    const r = importHod(hod(['sessionType=2', 'host=h'], ['[ColorRemap]', 'sBG=20587255718477824', 'fWT=20587255735255039']), 'Brown.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({ colorBackground: '#492400', colorWhite: '#ffffff' });
    expect(r.notes).toEqual([]);
  });

  it('reads the inactivity timeout in minutes, or from the milliseconds ACS also writes', () => {
    const both = importHod(hod(['sessionType=2', 'host=h', 'timeout=600000', 'panelOnlyTCPIPInactivityTimeout=10']), 'Idle.hod');
    expect(both.ok && both.session.inactivityTimeoutMinutes).toBe(10);
    const msOnly = importHod(hod(['sessionType=2', 'host=h', 'timeout=900000']), 'Idle.hod');
    expect(msOnly.ok && msOnly.session.inactivityTimeoutMinutes).toBe(15);
    const notWholeMinutes = importHod(hod(['sessionType=2', 'host=h', 'timeout=90000']), 'Idle.hod');
    const overAWeek = importHod(hod(['sessionType=2', 'host=h', 'panelOnlyTCPIPInactivityTimeout=20000']), 'Idle.hod');
    for (const r of [notWholeMinutes, overAWeek]) {
      if (!r.ok) throw new Error(r.reason);
      expect(r.session).not.toHaveProperty('inactivityTimeoutMinutes');
    }
  });

  it('takes the user ID only when Password Prompting uses the session user name', () => {
    const own = importHod(hod(['sessionType=2', 'host=h', 'acsPasswordPrompt=3_session', 'acsPasswordPromptUsername=demouser', 'userID=']), 'User.hod');
    expect(own.ok && own.session.signonUser).toBe('demouser');
    for (const mode of ['1_useAcsSetting', '2_shared', '5_kerberos']) {
      const r = importHod(hod(['sessionType=2', 'host=h', `acsPasswordPrompt=${mode}`, 'acsPasswordPromptUsername=olduser']), 'User.hod');
      if (!r.ok) throw new Error(r.reason);
      expect(r.session).not.toHaveProperty('signonUser');
    }
  });

  it('switches bypass signon on when ACS has it, with a note about the password', () => {
    const terminal = ['sessionType=2', 'host=h', 'ssoEnabled=true', 'ssoType=ssoBypassSignonEncrypted', 'ssoBypassSignonPassword=', 'acsPasswordPrompt=3_session', 'acsPasswordPromptUsername=DEMOUSER'];
    const r = importHod(hod(terminal), 'Bypass.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({ autoSignon: true, signonUser: 'DEMOUSER' });
    expect(r.notes).toEqual(['bypass signon: set the password with Set Password']);
    expect(JSON.stringify(r.session)).not.toMatch(/password/i);

    const noUser = importHod(hod(['sessionType=2', 'host=h', 'ssoEnabled=true', 'ssoType=ssoBypassSignonClearText', 'acsPasswordPrompt=1_useAcsSetting']), 'Bypass.hod');
    if (!noUser.ok) throw new Error(noUser.reason);
    expect(noUser.session.autoSignon).toBe(true);
    expect(noUser.notes).toEqual(['bypass signon: set the user ID, then the password with Set Password']);

    const off = importHod(hod(['sessionType=2', 'host=h', 'ssoEnabled=true', 'ssoType=ssoTypeNone']), 'Off.hod');
    if (!off.ok) throw new Error(off.reason);
    expect(off.session).not.toHaveProperty('autoSignon');
  });

  it('writes an IPv4 address with leading zeros the way ACS reads it, with a note', () => {
    const r = importHod(hod(['sessionType=2', 'host=10.020.3.4']), 'Backup.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.host).toBe('10.20.3.4');
    expect(r.notes).toEqual(['address 10.020.3.4 read as 10.20.3.4, as ACS does']);
  });

  it('names the connection after the file, not the sessionName several profiles may share', () => {
    const r = importHod(fixture, 'Pub400 - Release.hod');
    expect(r.ok && r.session.name).toBe('Pub400 - Release');
  });

  it('leaves out certificate checking and passwords, and bypass signon when ACS has it off', () => {
    const r = importHod(fixture, 'Pub400.hod');
    if (!r.ok) throw new Error(r.reason);
    for (const key of ['verifyCertificate', 'autoSignon', 'tlsPinnedCertificate']) expect(r.session).not.toHaveProperty(key);
    expect(JSON.stringify(r.session)).not.toMatch(/password/i);
  });

  it('takes auto-connect, auto-reconnect, keep-alive and the connection timeout only when the profile has them', () => {
    const r = importHod(hod(['sessionType=2', 'host=h', 'autoConnect=false', 'keepAlive=true', 'connectionTimeout=30', 'autoReconnect=maybe']), 'A.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({ autoConnect: false, keepAlive: true, connectTimeoutSeconds: 30 });
    expect(r.session).not.toHaveProperty('autoReconnect');
  });

  it('imports plain telnet at 24x80 with only the values present', () => {
    const r = importHod(hod(['sessionType=2', 'host=myibmi.example.com', 'port=23', 'SSL=false', 'screenSize=2', 'codePage=037', 'workstationID=', 'userID=']), 'Dev.hod');
    expect(r).toEqual({
      ok: true,
      session: { name: 'Dev', host: 'myibmi.example.com', port: 23, tls: false, screenSize: '24x80', codePage: 37 },
      notes: [],
    });
  });

  it('skips printer, 3270 and VT sessions with the reason', () => {
    const printer = ['[Host On-Demand Session File][4.00]', '[Terminal]', '[HostPrintTerminal]', 'sessionType=6', 'printerName=LPT1'].join('\r\n');
    expect(importHod(printer, 'Printer.hod')).toEqual({ ok: false, name: 'Printer', reason: '5250 printer session' });
    expect(importHod(hod(['sessionType=1', 'host=h']), 'Mainframe.hod')).toEqual({ ok: false, name: 'Mainframe', reason: '3270 display session' });
    expect(importHod(hod(['sessionType=3', 'host=h']), 'Unix.hod')).toEqual({ ok: false, name: 'Unix', reason: 'VT display session' });
    expect(importHod(hod(['host=h']), 'NoType.hod')).toEqual({ ok: false, name: 'NoType', reason: 'unknown session type' });
  });

  it('skips a profile without a host and a file that is not a session profile', () => {
    expect(importHod(hod(['sessionType=2', 'host=']), 'Blank.hod')).toEqual({ ok: false, name: 'Blank', reason: 'no host name' });
    expect(importHod('[KeyRemap]\r\nS10=[fldext]\r\n', 'Keys.hod')).toEqual({ ok: false, name: 'Keys', reason: 'not an ACS session profile' });
  });

  it('notes what it cannot carry over: other screen sizes, unsupported code pages, backup hosts', () => {
    const r = importHod(hod(['sessionType=2', 'host=h', 'screenSize=4', 'codePage=1399', 'hostBackup1=h2']), 'Odd.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.screenSize).toBe('24x80');
    expect(r.session).not.toHaveProperty('codePage');
    expect(r.notes).toEqual([
      'screen size 4 not in 5250, 24x80 used',
      'code page 1399 not supported, Defaults used',
      'backup hosts left out',
    ]);
  });

  it('ignores a port outside 1-65535', () => {
    const r = importHod(hod(['sessionType=2', 'host=h', 'port=70000']), 'Bad.hod');
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).not.toHaveProperty('port');
  });
});

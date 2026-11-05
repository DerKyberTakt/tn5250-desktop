/**
 * NEW-ENVIRON values that go with a host code page (RFC 4777 section 4: KBDTYPE,
 * CODEPAGE and CHARSET are USERVARs sent with DEVNAME; CODEPAGE and CHARSET are only
 * used when a KBDTYPE goes with them, otherwise the host takes its system values).
 *
 * CHARSET is the graphic character set id of the CCSID; KBDTYPE the 3-letter keyboard
 * type of IBM's "National language keyboard types and SBCS code pages" table (CRTDEVDSP
 * KBDTYPE). The euro code pages 1140-1149 are the same character sets with the euro sign
 * (GCSGID 695); their keyboard types are those of the code pages they replace. Several
 * countries share a code page (500, 277, 278, 284, 297 ...): the first keyboard IBM lists
 * is the default, the Keyboard type setting overrides it.
 */
export interface HostNls {
  charset: string;
  kbdType: string;
}

const NLS: Record<number, HostNls> = {
  37: { charset: '697', kbdType: 'USB' },
  273: { charset: '697', kbdType: 'AGB' },
  277: { charset: '697', kbdType: 'DMB' },
  278: { charset: '697', kbdType: 'FNB' },
  280: { charset: '697', kbdType: 'ITB' },
  284: { charset: '697', kbdType: 'SPB' },
  285: { charset: '697', kbdType: 'UKB' },
  297: { charset: '697', kbdType: 'FAB' },
  420: { charset: '235', kbdType: 'CLB' },
  424: { charset: '941', kbdType: 'NCB' },
  500: { charset: '697', kbdType: 'INB' },
  838: { charset: '1176', kbdType: 'THB' },
  870: { charset: '959', kbdType: 'CSB' },
  871: { charset: '697', kbdType: 'ICB' },
  875: { charset: '925', kbdType: 'GNB' },
  880: { charset: '960', kbdType: 'CYB' },
  1025: { charset: '1150', kbdType: 'BGB' },
  1026: { charset: '1152', kbdType: 'TKB' },
  1140: { charset: '695', kbdType: 'USB' },
  1141: { charset: '695', kbdType: 'AGB' },
  1142: { charset: '695', kbdType: 'DMB' },
  1143: { charset: '695', kbdType: 'FNB' },
  1144: { charset: '695', kbdType: 'ITB' },
  1145: { charset: '695', kbdType: 'SPB' },
  1146: { charset: '695', kbdType: 'UKB' },
  1147: { charset: '695', kbdType: 'FAB' },
  1148: { charset: '695', kbdType: 'INB' },
  1149: { charset: '695', kbdType: 'ICB' },
};

/**
 * The values for a code page, with an optional keyboard type override; undefined when
 * the code page is not in the table (send nothing, the host uses its defaults).
 */
export function hostNls(ccsid: number, keyboardType = ''): HostNls | undefined {
  const base = NLS[ccsid];
  const kbd = keyboardType.trim().toUpperCase();
  if (!base) return undefined;
  return kbd ? { charset: base.charset, kbdType: kbd } : base;
}

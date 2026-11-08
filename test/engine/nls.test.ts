import { describe, expect, it } from 'vitest';
import { hostNls } from '../../src/engine/nls';

describe('NEW-ENVIRON keyboard type and character set by code page', () => {
  it('sends the keyboard type IBM lists for the code page, not USB for everything (issue #5)', () => {
    expect(hostNls(37)).toEqual({ charset: '697', kbdType: 'USB' });
    expect(hostNls(273)).toEqual({ charset: '697', kbdType: 'AGB' });
    expect(hostNls(500)).toEqual({ charset: '697', kbdType: 'INB' });
    expect(hostNls(1141)).toEqual({ charset: '695', kbdType: 'AGE' }); // euro keyboard type, CRTDEVDSP KBDTYPE
    expect(hostNls(1140)).toEqual({ charset: '695', kbdType: 'USE' });
    expect(hostNls(1148)).toEqual({ charset: '695', kbdType: 'INB' });
  });

  it('an unknown code page sends nothing, so the host keeps its defaults', () => {
    expect(hostNls(12345)).toBeUndefined();
    expect(hostNls(12345, 'AGB')).toBeUndefined();
  });

  it('the Keyboard type setting overrides the keyboard, keeping the character set', () => {
    expect(hostNls(500, ' agb ')).toEqual({ charset: '697', kbdType: 'AGB' });
    expect(hostNls(500, '')).toEqual({ charset: '697', kbdType: 'INB' });
  });
});

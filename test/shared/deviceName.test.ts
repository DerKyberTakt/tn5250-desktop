import { describe, expect, it } from 'vitest';
import { expandDeviceName } from '../../src/shared/deviceName';

const ctx = { computerName: 'lt-kyle-01', userName: 'kyle', ordinal: 0 };

describe('expandDeviceName', () => {
  it('expands computer and user names, upper case, 10 characters max', () => {
    expect(expandDeviceName('&COMPN', ctx)).toBe('LTKYLE01');
    expect(expandDeviceName('&USERN*', ctx)).toBe('KYLEA');
    expect(expandDeviceName('&COMPN&USERN', ctx)).toBe('LTKYLE01KY');
  });

  it('adds a letter for * and a digit for = that follow the ordinal', () => {
    expect(expandDeviceName('OD1N*=', ctx)).toBe('OD1NA0');
    expect(expandDeviceName('OD1N*=', { ...ctx, ordinal: 2 })).toBe('OD1NC2');
    expect(expandDeviceName('VERYLONGNAME*', ctx)).toBe('VERYLONGNA');
  });

  it('keeps plain names and returns empty for blank', () => {
    expect(expandDeviceName(' dev01 ', ctx)).toBe('DEV01');
    expect(expandDeviceName('', ctx)).toBe('');
  });
});

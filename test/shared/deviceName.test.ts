import { describe, expect, it } from 'vitest';
import { expandDeviceName } from '../../src/shared/deviceName';

const ctx = { computerName: 'lt-alex-01', userName: 'alex', ordinal: 0 };

describe('expandDeviceName', () => {
  it('expands computer and user names, upper case, 10 characters max', () => {
    expect(expandDeviceName('&COMPN', ctx)).toBe('LTALEX01');
    expect(expandDeviceName('&USERN*', ctx)).toBe('ALEXA');
    expect(expandDeviceName('&COMPN&USERN', ctx)).toBe('LTALEX01AL');
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

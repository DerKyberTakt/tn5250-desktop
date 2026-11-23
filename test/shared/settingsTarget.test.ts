import { describe, expect, it } from 'vitest';
import { profileIndexOf, settingsTarget } from '../../src/shared/settingsTarget';

const sessions = [
  { name: 'Dev', host: 'PUB400.COM' },
  { name: 'Test', host: 'PUB400.COM' },
  { name: '', host: '127.0.0.1' },
  { name: 'Dev', host: '127.0.0.1' },
];

describe('profileIndexOf', () => {
  it('finds the connection of the session by name and host', () => {
    expect(profileIndexOf(sessions, { name: 'Test', host: 'PUB400.COM' })).toBe(1);
    expect(profileIndexOf(sessions, { name: 'Dev', host: '127.0.0.1' })).toBe(3);
  });

  it('falls back to the name when the host was changed since the session was opened', () => {
    expect(profileIndexOf(sessions, { name: 'Test', host: 'OTHER' })).toBe(1);
  });

  it('finds a connection without a name by its host', () => {
    expect(profileIndexOf(sessions, { name: '', host: '127.0.0.1' })).toBe(2);
    expect(profileIndexOf(sessions, { host: '127.0.0.1' })).toBe(2);
  });

  it('has no answer for no session, the demo screen or a connection that is not saved', () => {
    expect(profileIndexOf(sessions, undefined)).toBeUndefined();
    expect(profileIndexOf(sessions, {})).toBeUndefined();
    expect(profileIndexOf(sessions, { name: 'Gone', host: 'PUB400.COM' })).toBeUndefined();
    expect(profileIndexOf(sessions, { host: 'PUB400.COM' })).toBeUndefined();
    expect(profileIndexOf([], { name: 'Dev', host: 'PUB400.COM' })).toBeUndefined();
  });
});

describe('settingsTarget', () => {
  const test = { name: 'Test', host: 'PUB400.COM' };

  it('opens the page on the connection of the session being looked at', () => {
    expect(settingsTarget(sessions, test, undefined, -1)).toEqual({ select: 1 });
  });

  it('opens on the fallback when no session is being looked at', () => {
    expect(settingsTarget(sessions, undefined, undefined, -1)).toEqual({ select: -1 });
    expect(settingsTarget(sessions, undefined, undefined, 3)).toEqual({ select: 3 });
    expect(settingsTarget(sessions, { name: 'Gone' }, undefined, -1)).toEqual({ select: -1 });
  });

  it('moves an open page to the connection of the session being looked at', () => {
    expect(settingsTarget(sessions, test, -1, -1)).toEqual({ select: 1 });
    expect(settingsTarget(sessions, test, 0, -1)).toEqual({ select: 1 });
  });

  it('leaves an open page alone when it shows that connection already, or no session is looked at', () => {
    // A push of the same profile would throw away the unsaved changes on the page.
    expect(settingsTarget(sessions, test, 1, -1)).toBe('keep');
    expect(settingsTarget(sessions, undefined, 2, -1)).toBe('keep');
    expect(settingsTarget(sessions, undefined, -1, 0)).toBe('keep');
  });
});

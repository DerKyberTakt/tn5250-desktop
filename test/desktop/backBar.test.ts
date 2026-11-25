import { describe, expect, it } from 'vitest';
import { backTarget } from '../../src/desktop/backBar';

describe('the bar back to the session', () => {
  it('shows while a tool page is in front of the only session', () => {
    // The bug: with Settings in front there was no tab to click, only the Connections panel.
    expect(backTarget({ tabBarHidden: true, sessionInFront: false, sessions: ['a'], last: 'a' })).toBe('a');
  });

  it('is not needed while the session is in front, while the tab bar shows, or without a session', () => {
    expect(backTarget({ tabBarHidden: true, sessionInFront: true, sessions: ['a'], last: 'a' })).toBeUndefined();
    expect(backTarget({ tabBarHidden: false, sessionInFront: false, sessions: ['a', 'b'], last: 'a' })).toBeUndefined();
    expect(backTarget({ tabBarHidden: true, sessionInFront: false, sessions: [], last: undefined })).toBeUndefined();
  });

  it('goes to the session that was in front last, or the first one when that one is gone', () => {
    expect(backTarget({ tabBarHidden: true, sessionInFront: false, sessions: ['a', 'b'], last: 'b' })).toBe('b');
    expect(backTarget({ tabBarHidden: true, sessionInFront: false, sessions: ['a'], last: 'closed' })).toBe('a');
    expect(backTarget({ tabBarHidden: true, sessionInFront: false, sessions: ['a'], last: undefined })).toBe('a');
  });
});

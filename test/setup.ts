// Loaded before every test file. The Wails runtime starts a timer on `window` as soon as it is
// imported; in a jsdom test that timer can fire after the test's window is gone, which fails
// the whole run with "window is not defined" although every test passed. No test needs the
// real runtime (there is no app behind it), so it is replaced here.
import { vi } from 'vitest';

vi.mock('@wailsio/runtime', () => ({
  Application: { Quit: vi.fn() },
  Browser: { OpenURL: vi.fn() },
  Call: { ByName: vi.fn() },
  Events: { On: vi.fn() },
  Window: { SetTitle: vi.fn() },
}));

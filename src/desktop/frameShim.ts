/**
 * Loaded before the terminal and settings bundles inside their frames. Gives
 * them the acquireVsCodeApi() they were written against, backed by the shell
 * page that owns the frame: postMessage goes to the parent, and the parent
 * answers with frame.contentWindow.postMessage, which arrives as the usual
 * window "message" event. The bundles themselves stay unchanged.
 */

interface FrameApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let state: unknown;
const target = location.origin && location.origin !== 'null' ? location.origin : '*';

const api: FrameApi = {
  postMessage: (message) => window.parent.postMessage({ tn5250Frame: true, message }, target),
  getState: () => state,
  setState: (s) => {
    state = s;
  },
};

(window as unknown as { acquireVsCodeApi: () => FrameApi }).acquireVsCodeApi = () => api;

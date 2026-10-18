/** Minimal typing for the API VS Code injects into webviews. */
interface VsCodeWebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;

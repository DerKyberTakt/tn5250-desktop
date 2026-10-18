import * as vscode from 'vscode';

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'terminal.css'));
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>TN5250</title>
</head>
<body>
<div id="terminal" tabindex="0" aria-label="5250 terminal">
  <div id="viewport"><canvas id="screen"></canvas></div>
  <div id="oia" role="status"></div>
  <pre id="keylog" hidden></pre>
</div>
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
}

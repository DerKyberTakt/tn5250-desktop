// Builds the desktop page bundles into dist/desktop, which the Go binary embeds (main.go).
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production') || process.env.PRODUCTION === '1';
const watch = process.argv.includes('--watch');
const outdir = 'dist/desktop';

mkdirSync(outdir, { recursive: true });
cpSync('src/desktop/static', outdir, { recursive: true });

const pages = await esbuild.context({
  bundle: true,
  sourcemap: production ? false : 'inline',
  minify: production,
  target: 'es2022',
  logLevel: 'info',
  entryPoints: {
    // The terminal and settings pages are the VS Code webview bundles, unchanged.
    main: 'src/webview/main.ts',
    terminal: 'src/webview/terminal.css',
    settings: 'src/settings/main.ts',
    'settings-style': 'src/settings/settings.css',
    // Desktop only: the shell page and the frame shim.
    shell: 'src/desktop/shell.ts',
    shim: 'src/desktop/frameShim.ts',
  },
  outdir,
  format: 'iife',
  platform: 'browser',
});

if (watch) {
  await pages.watch();
} else {
  await pages.rebuild();
  await pages.dispose();
}

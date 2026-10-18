// Builds the extension host bundle (Node) and the webview bundle (browser).
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: production ? false : 'inline',
  minify: production,
  target: 'es2022',
  logLevel: 'info',
};

const extension = await esbuild.context({
  ...common,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
});

const webview = await esbuild.context({
  ...common,
  entryPoints: {
    main: 'src/webview/main.ts',
    terminal: 'src/webview/terminal.css',
    settings: 'src/settings/main.ts',
    'settings-style': 'src/settings/settings.css',
  },
  outdir: 'dist/webview',
  format: 'iife',
  platform: 'browser',
});

if (watch) {
  await Promise.all([extension.watch(), webview.watch()]);
} else {
  await Promise.all([extension.rebuild(), webview.rebuild()]);
  await Promise.all([extension.dispose(), webview.dispose()]);
}

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseFont } from './fontParse';

export interface FontInfo {
  family: string;
  monospace: boolean;
  file: string;
}

const MAX_FONT_BYTES = 10 * 1024 * 1024;
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc']);

function fontDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out);
    else if (e.isFile() && FONT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

let cache: FontInfo[] | undefined;

/** Installed fonts (family names), monospaced ones flagged. Cached for the session. */
export async function listSystemFonts(extra: string[] = []): Promise<FontInfo[]> {
  if (!cache) {
    const files: string[] = [];
    for (const d of fontDirs()) await walk(d, 2, files);
    const seen = new Map<string, FontInfo>();
    for (const file of files) {
      try {
        const fh = await fs.open(file, 'r');
        try {
          const head = Buffer.alloc(Math.min(262144, (await fh.stat()).size));
          await fh.read(head, 0, head.length, 0);
          const info = parseFont(head);
          if (info && !seen.has(info.family)) seen.set(info.family, { ...info, file });
        } finally {
          await fh.close();
        }
      } catch {
        // unreadable font, skip
      }
    }
    cache = [...seen.values()].sort((a, b) => a.family.localeCompare(b.family));
  }
  const extras: FontInfo[] = [];
  for (const file of extra) {
    try {
      const info = parseFont(await fs.readFile(file));
      if (info) extras.push({ ...info, file });
    } catch {
      // skip
    }
  }
  return [...extras, ...cache.filter((c) => !extras.some((e) => e.family === c.family))];
}

/** Copies a user-chosen TTF/OTF into the extension's storage; returns the stored path and family. */
export async function importFontFile(context: vscode.ExtensionContext, source: vscode.Uri): Promise<{ file: string; family: string }> {
  const ext = path.extname(source.fsPath).toLowerCase();
  if (ext !== '.ttf' && ext !== '.otf') throw new Error('only .ttf and .otf font files are accepted');
  const data = Buffer.from(await vscode.workspace.fs.readFile(source));
  if (data.length > MAX_FONT_BYTES) throw new Error('font file is larger than 10 MB');
  const info = parseFont(data);
  if (!info) throw new Error('not a valid TrueType/OpenType font');
  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'fonts');
  await vscode.workspace.fs.createDirectory(dir);
  const safe = info.family.replace(/[^\w.-]+/g, '_') + ext;
  const target = vscode.Uri.joinPath(dir, safe);
  await vscode.workspace.fs.writeFile(target, data);
  return { file: target.fsPath, family: info.family };
}

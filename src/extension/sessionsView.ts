import * as vscode from 'vscode';
import type { TerminalSettings } from '../shared/settings';
import { resolvedSessions } from './settingsStore';

export class SessionItem extends vscode.TreeItem {
  constructor(
    readonly profile: TerminalSettings,
    readonly index: number,
  ) {
    super(profile.name || profile.host, vscode.TreeItemCollapsibleState.None);
    this.description = `${profile.host}:${profile.port}${profile.tls ? ' TLS' : ''} ${profile.screenSize}`;
    this.tooltip = `${profile.host}:${profile.port}\n${profile.screenSize}, CCSID ${profile.codePage}${profile.deviceName ? `, device ${profile.deviceName}` : ''}`;
    this.tooltip = `Connect to IBM i (new tab)
${this.tooltip as string}`;
    this.iconPath = new vscode.ThemeIcon('terminal');
    this.contextValue = 'session';
    this.command = { command: 'tn5250.connectSession', title: 'Connect', arguments: [this] };
  }
}

/** The "Sessions" tree in the TN5250 side bar. */
export class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly changed = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tn5250')) this.changed.fire(undefined);
      }),
    );
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionItem[] {
    const items = resolvedSessions().map((p, i) => new SessionItem(p, i));
    if (vscode.workspace.getConfiguration('tn5250').get<string>('sessionsSort', 'manual') === 'name') {
      items.sort((a, b) => a.profile.name.localeCompare(b.profile.name, undefined, { sensitivity: 'base' }));
    }
    return items;
  }
}

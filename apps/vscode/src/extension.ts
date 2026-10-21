import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

const clients = new Map<string, LanguageClient>();
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const start = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    if (folder.uri.scheme !== 'file' || clients.has(folder.uri.toString())) return;
    // The lock and the active pointer change on restore, so a folder whose installation was refused is read again.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.ia/{**/*.ia,distributions.lock.json,distributions/active.json}'),
    );
    // One server per folder: the folder name tells their output channels and messages apart.
    const client = new LanguageClient(
      `ia-${folder.index}`,
      `IA language (${folder.name})`,
      {
        module: resolve(context.extensionPath, 'dist/server.cjs'),
        transport: TransportKind.stdio,
      },
      {
        workspaceFolder: folder,
        documentSelector: [
          { scheme: 'file', language: 'inventarch-ia', pattern: `${folder.uri.fsPath.replaceAll('\\', '/')}/**/*.ia` },
        ],
        initializationOptions: { protocol: 1, root: folder.uri.fsPath },
        synchronize: { fileEvents: watcher },
      },
    );
    clients.set(folder.uri.toString(), client);
    context.subscriptions.push(watcher);
    try {
      await client.start();
    } catch {
      // The client has already reported the failure under the folder's name; other folders keep their servers.
      clients.delete(folder.uri.toString());
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        const key = folder.uri.toString(),
          client = clients.get(key);
        clients.delete(key);
        void client?.stop();
      }
      for (const folder of event.added) void start(folder);
    }),
  );
  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(start));
}
export async function deactivate(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.stop()));
  clients.clear();
}

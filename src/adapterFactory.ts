// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import * as Net from 'net';
import DapConnection from './dap/connection';
import {Adapter} from './adapter/adapter';
import { ChromeAdapter } from './chrome/chromeAdapter';
import { NodeAdapter } from './node/nodeAdapter';

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  readonly context: vscode.ExtensionContext;
  private _sessions = new Map<string, { session: vscode.DebugSession, server: Net.Server, adapter: Adapter }>();
  private _disposables: vscode.Disposable[];
  private _activeAdapter?: Adapter;

  private _onAdapterAddedEmitter = new vscode.EventEmitter<Adapter>();
  private _onAdapterRemovedEmitter = new vscode.EventEmitter<Adapter>();
  private _onActiveAdapterChangedEmitter = new vscode.EventEmitter<Adapter>();
  readonly onAdapterAdded = this._onAdapterAddedEmitter.event;
  readonly onAdapterRemoved = this._onAdapterRemovedEmitter.event;
  readonly onActiveAdapterChanged = this._onActiveAdapterChangedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cdp', this));
    context.subscriptions.push(this);

    this._disposables = [
      vscode.debug.onDidStartDebugSession(session => {
        const value = this._sessions.get(session.id);
        if (value)
          this._onAdapterAddedEmitter.fire(value.adapter);
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const value = this._sessions.get(session.id);
        this._sessions.delete(session.id);
        if (value) {
          value.server.close();
          this._onAdapterRemovedEmitter.fire(value.adapter);
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession(session => {
        const value = session ? this._sessions.get(session.id) : undefined;
        if (value)
          this._activeAdapter = value.adapter;
        else
          this._activeAdapter = undefined;
        this._onActiveAdapterChangedEmitter.fire(this._activeAdapter);
      }),
      this._onAdapterAddedEmitter,
      this._onAdapterRemovedEmitter,
      this._onActiveAdapterChangedEmitter
    ];
  }

  activeAdapter(): Adapter | undefined {
    return this._activeAdapter;
  }

  adapter(sessionId: string): Adapter | undefined {
    const value = this._sessions.get(sessionId);
    return value ? value.adapter : undefined;
  }

  adapters(): Adapter[] {
    return Array.from(this._sessions.values()).map(v => v.adapter);
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const server = Net.createServer(async socket => {
      const connection = new DapConnection(socket, socket);
      const adapter = session.configuration['program'] ?
        await NodeAdapter.create(connection.dap()) :
        await ChromeAdapter.create(connection.dap(), this.context.storagePath || this.context.extensionPath);
      this._sessions.set(session.id, {session, server, adapter});
    }).listen(0);
    return new vscode.DebugAdapterServer(server.address().port);
  }

  dispose() {
    for (const [session, value] of this._sessions) {
      this._sessions.delete(session);
      value.server.close();
      this._onAdapterRemovedEmitter.fire(value.adapter);
    }
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
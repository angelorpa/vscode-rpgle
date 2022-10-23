/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, Uri } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	NotificationType,
	ProtocolNotificationType0,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);
	// The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [
			{ language: 'rpgle' },
		],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			//fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'languageServerExample',
		'Language Server Example',
		serverOptions,
		clientOptions
	);

	client.onReady().then(() => {
		client.onRequest("getUri", async (stringUri: string): Promise<string|undefined> => {
			const uri = Uri.parse(stringUri);
			let doc;
			try {
				doc = await workspace.openTextDocument(uri);
			} catch (e: any) {
				doc = undefined;
			}

			if (doc) {
				return doc.uri.toString();
			} else
			if (uri.scheme === `file`) {
				const basename = path.basename(uri.path);
				const [possibleFile] = await workspace.findFiles(`**/${basename}`, undefined, 1);
				if (possibleFile) {
					return possibleFile.toString();
				}
			}
		});
		client.onRequest("getFile", async (stringUri: string) : Promise<string|undefined> => { 
			// Always assumes URI is valid. Use getUri first
			const uri = Uri.parse(stringUri);
			const doc = await workspace.openTextDocument(uri);

			if (doc) {
				return doc.getText();
			}
		});
	});

	// Start the client. This will also launch the server
	client.start();

	console.log(`started`);
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

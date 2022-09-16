/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { SolanaDebugSession } from './solanaDebug';
import { FileAccessor } from './debugRuntime';

export async function activateSolanaDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {

	vscode.debug.startDebugging(undefined, {
		type: 'solana',
		name: 'Debug File',
		request: 'launch',
		program: '/home/wj/temp/test_theia/debug-test/code/sdk/program/src/entrypoint.rs',	
		stopOnEntry: true
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('extension.solana-debug.debugEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			console.log("target res path Debug File: ", targetResource);
			console.log("Alt: ", targetResource.scheme + '://' + targetResource.path);

			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
					type: 'solana',
					name: 'Debug File',
					request: 'launch',
					program: '/home/wj/temp/test_theia/debug-test/code/sdk/program/src/entrypoint.rs',	
					stopOnEntry: true
				});
			}
		}),
	);

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('solana', new InlineDebugAdapterFactory()));
}

export const workspaceFileAccessor: FileAccessor = {
	async readFile(path: string) {
		try {
			const uri = vscode.Uri.file(path);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const contents = Buffer.from(bytes).toString('utf8');
			return contents;
		} catch(e) {
			return `cannot read '${path}'`;
		}
	}
};

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new SolanaDebugSession(workspaceFileAccessor));
	}
}

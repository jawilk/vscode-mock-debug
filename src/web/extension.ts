/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { activateSolanaDebug } from '../activateSolanaDebug';

export function activate(context: vscode.ExtensionContext) {
	vscode.window.showInformationMessage('Running as web extension');
	activateSolanaDebug(context);
}

export function deactivate() {
	// nothing to do
}

// Runs inside VS Code with test-fixtures/plain-folder open (see .vscode-test.mjs).
import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Opened on an ordinary folder', () => {
	it('the extension stays inactive', async () => {
		const ext = vscode.extensions.getExtension('ajose.kernel-workbench');
		assert.ok(ext, 'extension ajose.kernel-workbench is not installed');
		// Activation on workspaceContains happens at startup; give it time to (wrongly) happen.
		await new Promise(resolve => setTimeout(resolve, 3000));
		assert.strictEqual(ext.isActive, false);
	});
});

// Runs inside VS Code with test-fixtures/kernel-tree open, and again with the real kernel clone
// open in the integration tests (see .vscode-test.mjs).
import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Opened on a kernel tree', () => {
	it('the extension activates', async () => {
		const ext = vscode.extensions.getExtension('ajose.kernel-workbench');
		assert.ok(ext, 'extension ajose.kernel-workbench is not installed');
		for (let i = 0; i < 100 && !ext.isActive; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.strictEqual(ext.isActive, true, 'not activated within 10 s');
	});
});

// Runs inside VS Code with test-fixtures/kernel-tree open (see .vscode-test.mjs).
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Opened on a kernel tree', () => {
	test('the extension activates', async () => {
		const ext = vscode.extensions.getExtension('ajose.kernel-dev');
		assert.ok(ext, 'extension ajose.kernel-dev is not installed');
		for (let i = 0; i < 100 && !ext.isActive; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.strictEqual(ext.isActive, true, 'not activated within 10 s');
	});
});

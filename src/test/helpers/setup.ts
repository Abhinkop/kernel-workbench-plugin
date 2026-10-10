// Loaded by mocha (.mocharc.json "require") before the unit tests: makes
// require('vscode') return the mock, and resets it before every test.
import Module = require('module');
import * as mock from './vscode';

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
	return request === 'vscode' ? mock.vscode : load.call(this, request, ...rest);
};

export const mochaHooks = {
	beforeEach() {
		mock.reset();
	},
};

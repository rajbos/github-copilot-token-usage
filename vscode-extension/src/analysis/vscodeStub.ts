/**
 * Stand-in for the `vscode` module inside the analysis worker bundle.
 *
 * Worker threads have no VS Code API. A few shared modules `import * as vscode` without
 * using it on the parsing path; this alias lets them bundle, and turns any real use into a
 * loud, specific error instead of an opaque `Cannot find module 'vscode'` at load time.
 */
const fail = (): never => {
	throw new Error('The VS Code API is not available inside the analysis worker. Keep vscode-dependent code on the extension host.');
};

module.exports = new Proxy({}, { get: (_target, property) => (property === '__esModule' ? false : fail()) });

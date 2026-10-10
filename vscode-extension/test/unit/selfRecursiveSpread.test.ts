import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/**
 * Catches a method that spreads a call to *itself* into the object it returns.
 *
 * `return { ...this.foo(), bar }` inside `foo()` is unconditionally infinite —
 * there is no argument or branch that could stop it — so it is always a bug,
 * never a recursion someone meant.
 *
 * This exists because exactly that shipped on #2138. A global find/replace that
 * rewrote `localization: this.getWebviewLocalization(),` into
 * `...this.getWebviewLocaleFields(),` also rewrote the line *inside*
 * `getWebviewLocaleFields()` itself. It type-checked, linted, passed the whole
 * unit suite and produced an identical visual diff, because nothing in the
 * suite constructs a webview payload — and at runtime every panel in the
 * extension would have died with a RangeError.
 *
 * Deliberately a source scan rather than a behavioural test: making the panel
 * builders callable from unit tests is a much larger refactor, and this shape
 * is decidable from the syntax alone.
 */

const EXTENSION_SRC = join(__dirname, '../../../../src/extension.ts');

/** `ClassName.methodName` for every method that spreads a call to itself. */
function findSelfRecursiveSpreads(filePath: string): string[] {
	const source = readFileSync(filePath, 'utf8');
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const offenders: string[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
			const methodName = node.name.text;

			const scan = (inner: ts.Node): void => {
				if (ts.isSpreadAssignment(inner) && ts.isCallExpression(inner.expression)) {
					const callee = inner.expression.expression;
					if (ts.isPropertyAccessExpression(callee)
						&& callee.expression.kind === ts.SyntaxKind.ThisKeyword
						&& ts.isIdentifier(callee.name)
						&& callee.name.text === methodName) {
						const { line } = ts.getLineAndCharacterOfPosition(sourceFile, inner.getStart(sourceFile));
						offenders.push(`${methodName}() spreads itself at line ${line + 1}`);
					}
				}
				// Don't descend into nested functions: `this` may be rebound and the
				// name may refer to something else entirely.
				if (!ts.isFunctionDeclaration(inner) && !ts.isMethodDeclaration(inner)) {
					ts.forEachChild(inner, scan);
				}
			};
			ts.forEachChild(node.body, scan);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return offenders;
}

test('extension.ts: no method spreads a call to itself', () => {
	assert.deepEqual(
		findSelfRecursiveSpreads(EXTENSION_SRC),
		[],
		'a method spreading its own return value recurses until RangeError',
	);
});

test('the self-recursion detector actually detects the shape', () => {
	// Guards the test above from passing because the scan silently found nothing.
	const fixture = `
		class Panel {
			private getFields(): Record<string, string> {
				return { ...this.getFields(), language: 'en' };
			}
			private getOther(): Record<string, string> {
				return { ...this.getFields(), extra: 'ok' };
			}
		}
	`;
	const sourceFile = ts.createSourceFile('fixture.ts', fixture, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
			const methodName = node.name.text;
			const scan = (inner: ts.Node): void => {
				if (ts.isSpreadAssignment(inner) && ts.isCallExpression(inner.expression)) {
					const callee = inner.expression.expression;
					if (ts.isPropertyAccessExpression(callee)
						&& callee.expression.kind === ts.SyntaxKind.ThisKeyword
						&& ts.isIdentifier(callee.name)
						&& callee.name.text === methodName) {
						found.push(methodName);
					}
				}
				ts.forEachChild(inner, scan);
			};
			ts.forEachChild(node.body, scan);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	// Only the self-spreading one — `getOther()` spreads a *different* method.
	assert.deepEqual(found, ['getFields']);
});

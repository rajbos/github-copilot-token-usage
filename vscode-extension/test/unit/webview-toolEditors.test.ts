import test from 'node:test';
import * as assert from 'node:assert/strict';
import { formatToolEditors, sanitizeToolCallsByEditor, toolCallsByEditorToRecord } from '../../src/webview/usage/toolEditors';

test('sanitizeToolCallsByEditor: keeps positive finite counts and drops malformed entries', () => {
    const out = sanitizeToolCallsByEditor({
        a: { 'VS Code': 3, Bad: -1, Nan: Number.NaN, Str: 'x' },
        b: 'nope',
        c: { Zero: 0 },
    });
    assert.deepEqual(out, { a: { 'VS Code': 3 } });
});

test('sanitizeToolCallsByEditor: non-object input yields undefined', () => {
    assert.equal(sanitizeToolCallsByEditor(null), undefined);
    assert.equal(sanitizeToolCallsByEditor('x'), undefined);
});

test('formatToolEditors: lists editors most-used first', () => {
    const data = { t: { 'VS Code': 2, 'Claude Code (CLI)': 9 } };
    assert.equal(formatToolEditors('t', data), 'Claude Code (CLI), VS Code');
});

test('formatToolEditors: empty for unknown tool or missing data', () => {
    assert.equal(formatToolEditors('t', {}), '');
    assert.equal(formatToolEditors('t', undefined), '');
});

test('sanitizeToolCallsByEditor: __proto__ / constructor keys stay own data and never pollute prototypes', () => {
    const raw = JSON.parse('{"__proto__":{"VS Code":3},"constructor":{"VS Code":2},"ok":{"__proto__":4}}');
    const out = sanitizeToolCallsByEditor(raw)!;
    assert.deepEqual(Object.keys(out).sort(), ['__proto__', 'constructor', 'ok']);
    assert.equal(Object.getOwnPropertyDescriptor(out, '__proto__')?.value['VS Code'], 3);
    assert.equal(Object.getOwnPropertyDescriptor(out, 'constructor')?.value['VS Code'], 2);
    assert.equal(Object.getOwnPropertyDescriptor(out.ok, '__proto__')?.value, 4);
    assert.equal(({} as Record<string, unknown>)['VS Code'], undefined);
    assert.equal(typeof (Object as unknown as Record<string, unknown>)['VS Code'], 'undefined');
});

test('formatToolEditors: ignores inherited properties like constructor', () => {
    assert.equal(formatToolEditors('constructor', {}), '');
    assert.equal(formatToolEditors('__proto__', {}), '');
});

test('toolCallsByEditorToRecord: __proto__ tool survives a JSON round trip', () => {
    const accum = new Map([['__proto__', new Map([['VS Code', 3]])], ['t', new Map([['CLI', 1]])]]);
    const record = toolCallsByEditorToRecord(accum);
    const roundTripped = JSON.parse(JSON.stringify(record));
    assert.deepEqual(Object.keys(roundTripped).sort(), ['__proto__', 't']);
    assert.equal(sanitizeToolCallsByEditor(roundTripped) !== undefined, true);
    assert.equal(Object.getOwnPropertyDescriptor(sanitizeToolCallsByEditor(roundTripped), '__proto__')?.value['VS Code'], 3);
});

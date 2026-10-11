import test from 'node:test';
import * as assert from 'node:assert/strict';
import { classifySessionScoping, plannedBeforeExecution, SHORT_PROMPT_CHARS } from '../../../src/promptScoping';

test('classifySessionScoping: a short prompt that goes straight to execution is under-scoped', () => {
    assert.equal(classifySessionScoping('fix it', ['Coding', 'Testing']), 'under-scoped');
});

test('classifySessionScoping: a long prompt is scoped', () => {
    assert.equal(classifySessionScoping('x'.repeat(SHORT_PROMPT_CHARS), ['Coding']), 'scoped');
    assert.equal(classifySessionScoping('x'.repeat(SHORT_PROMPT_CHARS - 1), ['Coding']), 'under-scoped');
});

test('classifySessionScoping: a planning turn before execution makes a short prompt scoped', () => {
    assert.equal(classifySessionScoping('add login', ['Exploration', 'Planning', 'Coding']), 'scoped');
    assert.equal(classifySessionScoping('add login', ['Coding', 'Planning']), 'under-scoped');
});

test('classifySessionScoping: slash commands carry their own objective', () => {
    assert.equal(classifySessionScoping('/fix', ['Coding']), 'scoped');
});

test('classifySessionScoping: no prompt means no judgement', () => {
    assert.equal(classifySessionScoping(undefined, ['Coding']), undefined);
    assert.equal(classifySessionScoping('   ', ['Coding']), undefined);
});

test('plannedBeforeExecution: reading turns do not end the search, execution does', () => {
    assert.equal(plannedBeforeExecution(['Exploration', 'Conversation', 'Planning']), true);
    assert.equal(plannedBeforeExecution(['Debugging', 'Planning']), false);
    assert.equal(plannedBeforeExecution(undefined), false);
});

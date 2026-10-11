import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    countParticipationModes,
    modeShares,
    participationModeMapping,
    addModeCounts,
    createEmptyModeCounts,
} from '../../../src/participationModes';
import { TASK_CATEGORIES } from '../../../src/taskClassification';

test('countParticipationModes: maps fixed categories to their mode', () => {
    assert.deepEqual(
        countParticipationModes(['Planning', 'Coding', 'Testing', 'Delegation', 'Git Ops', 'Conversation']),
        { director: 2, performer: 2, assessor: 1 },
    );
});

test('countParticipationModes: Exploration is director before the first performer turn and assessor after', () => {
    assert.deepEqual(countParticipationModes(['Exploration', 'Exploration', 'Coding', 'Exploration']), {
        director: 2, performer: 1, assessor: 1,
    });
});

test('countParticipationModes: empty or unknown input counts nothing', () => {
    assert.deepEqual(countParticipationModes(undefined), { director: 0, performer: 0, assessor: 0 });
    assert.deepEqual(countParticipationModes(['Mystery']), { director: 0, performer: 0, assessor: 0 });
});

test('participationModeMapping: covers every task category', () => {
    const mapping = participationModeMapping();
    for (const category of TASK_CATEGORIES) {
        assert.ok(category in mapping, `missing mapping for ${category}`);
    }
});

test('modeShares: fractions sum to one, and zero counts give zero shares', () => {
    const shares = modeShares({ director: 1, performer: 2, assessor: 1 });
    assert.equal(shares.performer, 0.5);
    assert.equal(shares.director + shares.performer + shares.assessor, 1);
    assert.deepEqual(modeShares(createEmptyModeCounts()), { director: 0, performer: 0, assessor: 0 });
});

test('addModeCounts: adds in place', () => {
    const target = { director: 1, performer: 1, assessor: 1 };
    addModeCounts(target, { director: 1, performer: 2, assessor: 3 });
    assert.deepEqual(target, { director: 2, performer: 3, assessor: 4 });
});

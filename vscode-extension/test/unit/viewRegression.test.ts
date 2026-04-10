import './vscode-shim-register';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createViewRegressionProbeScript,
  evaluateViewRegressionProbe,
  formatLocalViewRegressionReport,
  type LocalViewRegressionResult,
  type ViewRegressionProbeSnapshot,
} from '../../src/viewRegression';

function createSnapshot(overrides: Partial<ViewRegressionProbeSnapshot> = {}): ViewRegressionProbeSnapshot {
  return {
    rootChildCount: 4,
    rootTextLength: 180,
    bodyTextLength: 220,
    canvasCount: 1,
    svgCount: 0,
    tableCount: 1,
    buttonCount: 4,
    bodyTextSample: 'Loaded regression sample content',
    ...overrides,
  };
}

describe('viewRegression helpers', () => {
  test('evaluateViewRegressionProbe passes when metrics satisfy expectations', () => {
    const result = evaluateViewRegressionProbe(
      { minRootChildren: 1, minBodyTextLength: 100, minCanvasOrSvg: 1 },
      createSnapshot(),
    );

    assert.equal(result.pass, true);
    assert.match(result.summary, /Rendered 4 root nodes/);
  });

  test('evaluateViewRegressionProbe fails on loading text and missing chart surface', () => {
    const result = evaluateViewRegressionProbe(
      { minBodyTextLength: 100, minCanvasOrSvg: 1, disallowTextPatterns: ['loading...'] },
      createSnapshot({
        canvasCount: 0,
        svgCount: 0,
        bodyTextSample: 'Loading...',
      }),
    );

    assert.equal(result.pass, false);
    assert.match(result.summary, /canvas\/svg count 0 < 1/);
    assert.match(result.summary, /text contains "loading\.\.\."/);
  });

  test('createViewRegressionProbeScript emits the webview message contract', () => {
    const script = createViewRegressionProbeScript('nonce-1', {
      runId: 'run-1',
      viewId: 'details',
      title: 'Details',
      timeoutMs: 5000,
      expectations: { minBodyTextLength: 50 },
    });

    assert.match(script, /localViewRegressionReport/);
    assert.match(script, /"viewId":"details"/);
    assert.match(script, /"minBodyTextLength":50/);
  });

  test('formatLocalViewRegressionReport includes status counts and details', () => {
    const report = formatLocalViewRegressionReport([
      {
        id: 'details',
        title: 'Details',
        status: 'pass',
        detail: 'Rendered fine.',
        dataPoints: [{ label: '30d tokens', value: 1234 }],
        probe: createSnapshot(),
      },
      {
        id: 'dashboard',
        title: 'Team Dashboard',
        status: 'skip',
        detail: 'Skipped because backend is required.',
      },
    ] satisfies LocalViewRegressionResult[]);

    assert.match(report, /Passed: 1  Failed: 0  Skipped: 1/);
    assert.match(report, /\[PASS\] Details: Rendered fine\./);
    assert.match(report, /30d tokens=1234/);
    assert.match(report, /\[SKIP\] Team Dashboard: Skipped because backend is required\./);
  });
});

export interface ViewRegressionExpectation {
  minRootChildren?: number;
  minRootTextLength?: number;
  minBodyTextLength?: number;
  minCanvasOrSvg?: number;
  disallowTextPatterns?: string[];
}

export interface ViewRegressionProbeConfig {
  runId: string;
  viewId: string;
  title: string;
  timeoutMs: number;
  initialDelayMs?: number;
  expectations: ViewRegressionExpectation;
}

export interface ViewRegressionProbeSnapshot {
  rootChildCount: number;
  rootTextLength: number;
  bodyTextLength: number;
  canvasCount: number;
  svgCount: number;
  tableCount: number;
  buttonCount: number;
  bodyTextSample: string;
}

export interface ViewRegressionEvaluation {
  pass: boolean;
  summary: string;
}

export interface LocalViewRegressionMetric {
  label: string;
  value: string | number;
}

export interface LocalViewRegressionResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  dataPoints?: LocalViewRegressionMetric[];
  probe?: ViewRegressionProbeSnapshot;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function evaluateViewRegressionProbe(
  expectations: ViewRegressionExpectation,
  snapshot: ViewRegressionProbeSnapshot,
): ViewRegressionEvaluation {
  const reasons: string[] = [];
  const textSample = normalizeText(snapshot.bodyTextSample).toLowerCase();
  const minRootChildren = expectations.minRootChildren ?? 1;
  const minRootTextLength = expectations.minRootTextLength ?? 0;
  const minBodyTextLength = expectations.minBodyTextLength ?? 0;
  const minCanvasOrSvg = expectations.minCanvasOrSvg ?? 0;

  if (snapshot.rootChildCount < minRootChildren) {
    reasons.push(`root child count ${snapshot.rootChildCount} < ${minRootChildren}`);
  }
  if (snapshot.rootTextLength < minRootTextLength) {
    reasons.push(`root text length ${snapshot.rootTextLength} < ${minRootTextLength}`);
  }
  if (snapshot.bodyTextLength < minBodyTextLength) {
    reasons.push(`body text length ${snapshot.bodyTextLength} < ${minBodyTextLength}`);
  }
  if ((snapshot.canvasCount + snapshot.svgCount) < minCanvasOrSvg) {
    reasons.push(`canvas/svg count ${snapshot.canvasCount + snapshot.svgCount} < ${minCanvasOrSvg}`);
  }

  for (const pattern of expectations.disallowTextPatterns ?? []) {
    if (pattern && textSample.includes(pattern.toLowerCase())) {
      reasons.push(`text contains "${pattern}"`);
    }
  }

  if (reasons.length === 0) {
    return {
      pass: true,
      summary: `Rendered ${snapshot.rootChildCount} root nodes, ${snapshot.bodyTextLength} chars, ${snapshot.canvasCount + snapshot.svgCount} chart surface(s).`,
    };
  }

  return {
    pass: false,
    summary: reasons.join('; '),
  };
}

export function createViewRegressionProbeScript(
  nonce: string,
  config?: ViewRegressionProbeConfig,
): string {
  if (!config) {
    return '';
  }

  const safeConfig = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script nonce="${nonce}">
(() => {
  const config = ${safeConfig};

  // Acquire the VS Code API and patch the global so the main bundle's call is safe.
  // acquireVsCodeApi() may only be called once per webview; subsequent calls throw.
  // By replacing the global with a function that returns the cached instance the main
  // bundle (which runs after this probe) will reuse the same object without errors.
  let vscode;
  if (typeof acquireVsCodeApi === 'function') {
    vscode = acquireVsCodeApi();
    const _cached = vscode;
    try { window.acquireVsCodeApi = () => _cached; } catch (_) { /* read-only env */ }
  }
  if (!vscode) {
    return;
  }

  const normalizeText = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const evaluate = (snapshot) => {
    const reasons = [];
    const expectations = config.expectations ?? {};
    const textSample = normalizeText(snapshot.bodyTextSample).toLowerCase();
    const minRootChildren = expectations.minRootChildren ?? 1;
    const minRootTextLength = expectations.minRootTextLength ?? 0;
    const minBodyTextLength = expectations.minBodyTextLength ?? 0;
    const minCanvasOrSvg = expectations.minCanvasOrSvg ?? 0;

    if (snapshot.rootChildCount < minRootChildren) {
      reasons.push(\`root child count \${snapshot.rootChildCount} < \${minRootChildren}\`);
    }
    if (snapshot.rootTextLength < minRootTextLength) {
      reasons.push(\`root text length \${snapshot.rootTextLength} < \${minRootTextLength}\`);
    }
    if (snapshot.bodyTextLength < minBodyTextLength) {
      reasons.push(\`body text length \${snapshot.bodyTextLength} < \${minBodyTextLength}\`);
    }
    if ((snapshot.canvasCount + snapshot.svgCount) < minCanvasOrSvg) {
      reasons.push(\`canvas/svg count \${snapshot.canvasCount + snapshot.svgCount} < \${minCanvasOrSvg}\`);
    }

    for (const pattern of expectations.disallowTextPatterns ?? []) {
      if (pattern && textSample.includes(String(pattern).toLowerCase())) {
        reasons.push(\`text contains "\${pattern}"\`);
      }
    }

    if (reasons.length === 0) {
      return {
        pass: true,
        summary: \`Rendered \${snapshot.rootChildCount} root nodes, \${snapshot.bodyTextLength} chars, \${snapshot.canvasCount + snapshot.svgCount} chart surface(s).\`,
      };
    }

    return {
      pass: false,
      summary: reasons.join('; '),
    };
  };

  const collectSnapshot = () => {
    const root = document.getElementById('root');
    const bodyText = normalizeText(document.body?.innerText ?? document.body?.textContent ?? '');
    const rootText = normalizeText(root?.innerText ?? root?.textContent ?? '');
    return {
      rootChildCount: root?.childElementCount ?? 0,
      rootTextLength: rootText.length,
      bodyTextLength: bodyText.length,
      canvasCount: document.querySelectorAll('canvas').length,
      svgCount: document.querySelectorAll('svg').length,
      tableCount: document.querySelectorAll('table').length,
      buttonCount: document.querySelectorAll('button, vscode-button').length,
      bodyTextSample: bodyText.slice(0, 240),
    };
  };

  let settled = false;
  const finish = (result, snapshot, timedOut) => {
    if (settled) {
      return;
    }
    settled = true;
    vscode.postMessage({
      command: 'localViewRegressionReport',
      runId: config.runId,
      viewId: config.viewId,
      title: config.title,
      pass: result.pass,
      summary: result.summary,
      timedOut,
      metrics: snapshot,
    });
  };

  const deadline = Date.now() + Math.max(config.timeoutMs ?? 10000, 1000);
  const tick = () => {
    if (settled) {
      return;
    }
    const snapshot = collectSnapshot();
    const evaluation = evaluate(snapshot);
    if (evaluation.pass) {
      finish(evaluation, snapshot, false);
      return;
    }
    if (Date.now() >= deadline) {
      finish(evaluation, snapshot, true);
      return;
    }
    setTimeout(tick, 200);
  };

  window.addEventListener('message', () => {
    if (!settled) {
      setTimeout(tick, 50);
    }
  });
  window.addEventListener('load', () => {
    setTimeout(tick, config.initialDelayMs ?? 150);
  });
  setTimeout(tick, config.initialDelayMs ?? 150);
})();
</script>`;
}

export function formatLocalViewRegressionReport(
  results: LocalViewRegressionResult[],
): string {
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const skipped = results.filter((result) => result.status === 'skip').length;

  const lines = [
    'AI Engineering Fluency — Local view regression',
    `Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`,
    '',
  ];

  for (const result of results) {
    const statusLabel =
      result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'SKIP';
    const metrics = (result.dataPoints ?? [])
      .map((metric) => `${metric.label}=${metric.value}`)
      .join(', ');
    const probe = result.probe
      ? `probe(root=${result.probe.rootChildCount}, body=${result.probe.bodyTextLength}, canvas+svg=${result.probe.canvasCount + result.probe.svgCount})`
      : '';
    const extra = [metrics, probe].filter(Boolean).join(' | ');
    lines.push(`- [${statusLabel}] ${result.title}: ${result.detail}${extra ? ` | ${extra}` : ''}`);
  }

  return lines.join('\n');
}

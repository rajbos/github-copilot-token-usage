export interface ModelUsage {
    [model: string]: { inputTokens: number; outputTokens: number; sessions: number };
}

import { extractSubAgentData, extractResponseItemText } from './tokenEstimation';
import { safeJsonParse } from './utils/jsonParse';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { type JsonObject, isObject, isSafePathSegment, isArrayIndexSegment, normalizeModelId } from './utils/typeGuards';

interface MessagePart {
  text?: string;
}

interface RequestMessage {
  parts?: MessagePart[];
  text?: string;
}

interface ResponseItem {
  kind?: string;
  value?: string;
  content?: { value?: string };
  message?: { parts?: MessagePart[] };
}

interface RequestResult {
  usage?: { promptTokens?: number; completionTokens?: number };
  promptTokens?: number;
  outputTokens?: number;
  metadata?: { promptTokens?: number; outputTokens?: number; modelId?: string };
  details?: string;
}

interface ProcessableRequest {
  modelId?: string;
  selectedModel?: { identifier?: string };
  model?: string;
  message?: RequestMessage;
  response?: ResponseItem[];
  responses?: ResponseItem[];
  result?: RequestResult;
}

function traverseDeltaPath(
  root: JsonObject | unknown[],
  path: string[],
  ensureChild: (parent: JsonObject, key: string, nextSeg: string) => JsonObject | unknown[]
): { root: JsonObject | unknown[]; current: JsonObject | unknown[] } | null {
  let current: JsonObject | unknown[] = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const nextSeg = path[i + 1];
    if (Array.isArray(current) && isArrayIndexSegment(seg)) {
      const idx = Number(seg);
      const rawExisting = current[idx];
      let nextNode: JsonObject | unknown[];
      if (!isObject(rawExisting)) {
        nextNode = isArrayIndexSegment(nextSeg) ? [] : Object.create(null);
        current[idx] = nextNode;
      } else {
        nextNode = rawExisting;
      }
      current = nextNode;
      continue;
    }
    // Non-index keys on an array (e.g. 'length') can't be traversed or replaced safely.
    if (!isObject(current) || Array.isArray(current)) { return null; }
    current = ensureChild(current, seg, nextSeg);
  }
  return { root, current };
}

function applyDeltaKind1(root: JsonObject | unknown[], current: JsonObject | unknown[], lastSeg: string, v: unknown): unknown {
  if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
    current[Number(lastSeg)] = v;
    return root;
  }
  // Non-index keys on an array (e.g. 'length') would throw or corrupt it; ignore them.
  if (isObject(current) && !Array.isArray(current)) {
    Object.defineProperty(current, lastSeg, { value: v, writable: true, enumerable: true, configurable: true });
  }
  return root;
}

function applyDeltaKind2(root: JsonObject | unknown[], current: JsonObject | unknown[], lastSeg: string, v: unknown): unknown {
  let target: unknown[] | undefined;
  if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
    const idx = Number(lastSeg);
    if (!Array.isArray(current[idx])) { current[idx] = []; }
    target = current[idx] as unknown[];
  } else if (isObject(current) && !Array.isArray(current)) {
    if (!Array.isArray(current[lastSeg])) {
      Object.defineProperty(current, lastSeg, { value: [], writable: true, enumerable: true, configurable: true });
    }
    target = current[lastSeg] as unknown[];
  }
  if (Array.isArray(target)) {
    if (Array.isArray(v)) { target.push(...v); }
    else { target.push(v); }
  }
  return root;
}

/**
 * Apply a delta to reconstruct session state from delta-based JSONL
 * VS Code Insiders uses this format where:
 * - kind: 0 = initial state (full replacement)
 * - kind: 1 = update at key path
 * - kind: 2 = append to array at key path
 * - k = key path (array of strings)
 * - v = value
 */
function applyDelta(state: unknown, delta: unknown): unknown {
  if (!isObject(delta)) { return state; }

  const kind = delta['kind'];
  const k = delta['k'];
  const v = delta['v'];

  if (kind === 0) { return v; }
  if (!Array.isArray(k) || k.length === 0) { return state; }

  const path = k.map(String);
  for (const seg of path) {
    if (!isSafePathSegment(seg)) { return state; }
  }

  const root: JsonObject | unknown[] = isObject(state) ? state : Object.create(null);
  const ensureChildContainer = (parent: JsonObject, key: string, nextSeg: string): JsonObject | unknown[] => {
    const existing = parent[key];
    if (!isObject(existing)) {
      const newNode: JsonObject | unknown[] = isArrayIndexSegment(nextSeg) ? [] : Object.create(null);
      parent[key] = newNode;
      return newNode;
    }
    return existing;
  };

  const traverseResult = traverseDeltaPath(root, path, ensureChildContainer);
  if (!traverseResult) { return root; }
  const { root: r, current } = traverseResult;

  const lastSeg = path[path.length - 1];
  if (kind === 1) { return applyDeltaKind1(r, current, lastSeg, v); }
  if (kind === 2) { return applyDeltaKind2(r, current, lastSeg, v); }
  return r;
}

/**
 * Extract text content from response items, separating thinking text.
 */
function extractResponseAndThinkingText(response: unknown): { responseText: string; thinkingText: string } {
if (!Array.isArray(response)) {
return { responseText: '', thinkingText: '' };
}
let responseText = '';
let thinkingText = '';
for (const item of response) {
const { text, isThinking } = extractResponseItemText(item);
if (text) {
if (isThinking) { thinkingText += text; }
else { responseText += text; }
}
}
return { responseText, thinkingText };
}

/** Accumulates per-model and aggregate token counts during session parsing. */
export class TokenAccumulator {
    readonly modelUsage: ModelUsage = {};
    totalInputTokens = 0;
    totalOutputTokens = 0;

    constructor(
        private readonly defaultModel: string,
        private readonly estimateTokens: (text: string, model?: string) => number
    ) {}

    ensureModel(m?: string): string {
        return typeof m === 'string' && m ? m : this.defaultModel;
    }

    addInput(model: string, text: string): void {
        const m = this.ensureModel(model);
        // Untrusted `model` string from parsed session JSON — see protoGuard.ts.
        if (isUnsafeObjectKey(m)) { return; }
        if (!this.modelUsage[m]) { this.modelUsage[m] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
        const t = this.estimateTokens(text, m);
        this.modelUsage[m].inputTokens += t;
        this.totalInputTokens += t;
    }

    addOutput(model: string, text: string): void {
        const m = this.ensureModel(model);
        // Untrusted `model` string from parsed session JSON — see protoGuard.ts.
        if (isUnsafeObjectKey(m)) { return; }
        if (!this.modelUsage[m]) { this.modelUsage[m] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
        const t = this.estimateTokens(text, m);
        this.modelUsage[m].outputTokens += t;
        this.totalOutputTokens += t;
    }
}

function resolveRequestModel(
  req: ProcessableRequest,
  getModelFromRequest: ((req: ProcessableRequest) => string) | undefined,
  defaultModel: string
): string {
  const rawRequestModel = req.modelId ?? req.selectedModel?.identifier ?? req.model;
  const requestModel = normalizeModelId(rawRequestModel, defaultModel);
  if (typeof rawRequestModel === 'string' && rawRequestModel.trim()) { return requestModel; }
  const callbackModelRaw = getModelFromRequest ? getModelFromRequest(req) : undefined;
  return normalizeModelId(callbackModelRaw, '') || requestModel;
}

function accumulateRequestInput(
  req: ProcessableRequest,
  model: string,
  addInput: (m: string, text: string) => void
): void {
  if (req.message?.parts) {
    for (const part of req.message.parts) {
      if (typeof part?.text === 'string' && part.text) { addInput(model, part.text); }
    }
  } else if (typeof req.message?.text === 'string') {
    addInput(model, req.message.text);
  }
}

function handleSubAgentItem(
  subAgent: { modelName?: string; prompt?: string; result?: string },
  model: string,
  addInput: (m: string, text: string) => void,
  addOutput: (m: string, text: string) => void
): void {
  const saModel = subAgent.modelName || model;
  if (subAgent.prompt) { addInput(saModel, subAgent.prompt); }
  if (subAgent.result) { addOutput(saModel, subAgent.result); }
}

function processResponseItem(
  responseItem: ResponseItem,
  model: string,
  addInput: (m: string, text: string) => void,
  addOutput: (m: string, text: string) => void
): void {
  const subAgent = extractSubAgentData(responseItem);
  if (subAgent) {
    handleSubAgentItem(subAgent, model, addInput, addOutput);
    return;
  }
  // .value (including thinking) already handled by extractResponseAndThinkingText — skip
  if (responseItem && (responseItem.kind === 'thinking' || typeof responseItem.value === 'string')) { return; }
  // message.parts not covered by extractResponseAndThinkingText
  const parts = responseItem?.message?.parts;
  if (parts) {
    for (const p of parts) {
      if (typeof p?.text === 'string' && p.text) { addOutput(model, p.text); }
    }
  }
}

function accumulateResponseItems(
  responseItems: ResponseItem[],
  model: string,
  addInput: (m: string, text: string) => void,
  addOutput: (m: string, text: string) => void
): void {
  for (const item of responseItems) { processResponseItem(item, model, addInput, addOutput); }
}

function extractActualTokenCount(result: RequestResult | undefined): number {
  if (!result) { return 0; }
  if (result.usage) {
    const prompt = typeof result.usage.promptTokens === 'number' ? result.usage.promptTokens : 0;
    const completion = typeof result.usage.completionTokens === 'number' ? result.usage.completionTokens : 0;
    return prompt + completion;
  }
  if (typeof result.promptTokens === 'number' && typeof result.outputTokens === 'number') {
    return result.promptTokens + result.outputTokens;
  }
  if (result.metadata && typeof result.metadata.promptTokens === 'number' && typeof result.metadata.outputTokens === 'number') {
    return result.metadata.promptTokens + result.metadata.outputTokens;
  }
  return 0;
}

function extractJsonRequests(sessionJson: Record<string, unknown>): unknown[] {
  if (Array.isArray(sessionJson['requests'])) { return sessionJson['requests'] as unknown[]; }
  if (Array.isArray(sessionJson['history'])) { return sessionJson['history'] as unknown[]; }
  return [];
}

function isNonEmptyLine(l: string): boolean { return l.trim().length > 0; }

interface ParseState {
  thinkingTokens: number;
  actualTokens: number;
}

function processRequest(
  request: unknown,
  state: ParseState,
  addInput: (m: string, text: string) => void,
  addOutput: (m: string, text: string) => void,
  getModelFromRequest: ((req: ProcessableRequest) => string) | undefined,
  defaultModel: string,
  estimateTokensFromText: (text: string, model?: string) => number
): void {
  if (request === null || request === undefined || typeof request !== 'object') { return; }
  const req = request as ProcessableRequest;
  const model = resolveRequestModel(req, getModelFromRequest, defaultModel);
  accumulateRequestInput(req, model, addInput);
  const { responseText, thinkingText } = extractResponseAndThinkingText(req.response);
  if (responseText) { addOutput(model, responseText); }
  if (thinkingText) { state.thinkingTokens += estimateTokensFromText(thinkingText, model); }
  const responseItems: ResponseItem[] = Array.isArray(req.response) ? req.response : (Array.isArray(req.responses) ? req.responses : []);
  accumulateResponseItems(responseItems, model, addInput, addOutput);
  state.actualTokens += extractActualTokenCount(req.result);
}

function isUserInteractionRequest(r: unknown): boolean {
  if (!isObject(r)) { return false; }
  const msg = r['message'];
  return isObject(msg) && typeof msg['text'] === 'string' && !!(msg['text'] as string).trim();
}

function reconstructDeltaRequests(lines: string[]): unknown[] | null {
  if (lines.length === 0) { return null; }
  const first = safeJsonParse<{ kind?: number }>(lines[0], 'sessionParser');
  if (!first || typeof first.kind !== 'number') { return null; }
  let sessionState: unknown = Object.create(null);
  for (const line of lines) {
    const delta = safeJsonParse<unknown>(line, 'sessionParser');
    if (delta !== undefined) { sessionState = applyDelta(sessionState, delta); }
  }
  const sessionStateObj = isObject(sessionState) ? sessionState : null;
  return sessionStateObj && Array.isArray(sessionStateObj['requests']) ? (sessionStateObj['requests'] as unknown[]) : [];
}

export function parseSessionFileContent(
sessionFilePath: string,
fileContent: string,
estimateTokensFromText: (text: string, model?: string) => number,
getModelFromRequest?: (req: ProcessableRequest) => string
) {
let sessionJson: unknown;
const defaultModel = 'unknown';
const accumulator = new TokenAccumulator(defaultModel, estimateTokensFromText);
const { modelUsage } = accumulator;
const addInput = accumulator.addInput.bind(accumulator);
const addOutput = accumulator.addOutput.bind(accumulator);
const state: ParseState = { thinkingTokens: 0, actualTokens: 0 };

if (sessionFilePath.endsWith('.jsonl')) {
const lines = fileContent.split(/\r?\n/).filter(isNonEmptyLine);
const deltaRequests = reconstructDeltaRequests(lines);
if (deltaRequests !== null) {
const interactions = deltaRequests.filter(isUserInteractionRequest).length;
for (const r of deltaRequests) { processRequest(r, state, addInput, addOutput, getModelFromRequest, defaultModel, estimateTokensFromText); }
return { tokens: accumulator.totalInputTokens + accumulator.totalOutputTokens + state.thinkingTokens, interactions, modelUsage, thinkingTokens: state.thinkingTokens, actualTokens: 0 };
}
sessionJson = safeJsonParse<unknown>(fileContent.trim(), 'sessionParser');
if (sessionJson === undefined) { return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 }; }
}

if (!sessionJson) {
sessionJson = safeJsonParse<unknown>(fileContent, 'sessionParser');
if (sessionJson === undefined) { return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 }; }
}

if (!isObject(sessionJson) || Array.isArray(sessionJson)) {
return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 };
}

const requests = extractJsonRequests(sessionJson as Record<string, unknown>);
const interactions = requests.length;
for (const request of requests) { processRequest(request, state, addInput, addOutput, getModelFromRequest, defaultModel, estimateTokensFromText); }

return {
tokens: accumulator.totalInputTokens + accumulator.totalOutputTokens + state.thinkingTokens,
interactions,
modelUsage,
thinkingTokens: state.thinkingTokens,
actualTokens: state.actualTokens,
};
}

export default { parseSessionFileContent };

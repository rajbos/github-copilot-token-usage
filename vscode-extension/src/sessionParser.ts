export interface ModelUsage {
    [model: string]: { inputTokens: number; outputTokens: number };
}

import { extractSubAgentData } from './tokenEstimation';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
return typeof value === 'object' && value !== null;
}

function isSafePathSegment(seg: string): boolean {
// Prevent prototype pollution and other surprising behavior.
if (typeof seg !== 'string') {
return false;
}
const forbidden = ['__proto__', 'prototype', 'constructor', 'hasOwnProperty'];
return !forbidden.includes(seg) && !seg.startsWith('__');
}

function isArrayIndexSegment(seg: string): boolean {
return /^\d+$/.test(seg);
}

function normalizeModelId(model: unknown, defaultModel: string): string {
if (typeof model !== 'string') {
return defaultModel;
}
const trimmed = model.trim();
if (!trimmed) {
return defaultModel;
}
return trimmed.startsWith('copilot/') ? trimmed.substring('copilot/'.length) : trimmed;
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
if (!isObject(delta)) {
return state;
}

const kind = (delta as any).kind;
const k = (delta as any).k;
const v = (delta as any).v;

if (kind === 0) {
// Initial state - full replacement
return v;
}

if (!Array.isArray(k) || k.length === 0) {
return state;
}

const path = k.map(String);
for (const seg of path) {
if (!isSafePathSegment(seg)) {
return state;
}
}

let root: any = isObject(state) ? state : Object.create(null);
let current: any = root;

const ensureChildContainer = (parent: any, key: string, nextSeg: string): any => {
const wantsArray = isArrayIndexSegment(nextSeg);
let existing = parent[key];
if (!isObject(existing)) {
existing = wantsArray ? [] : Object.create(null);
parent[key] = existing;
}
return existing;
};

// Traverse to the parent of the target location
for (let i = 0; i < path.length - 1; i++) {
const seg = path[i];
const nextSeg = path[i + 1];

if (Array.isArray(current) && isArrayIndexSegment(seg)) {
const idx = Number(seg);
let existing = current[idx];
if (!isObject(existing)) {
existing = isArrayIndexSegment(nextSeg) ? [] : Object.create(null);
current[idx] = existing;
}
current = existing;
continue;
}

if (!isObject(current)) {
return root;
}
current = ensureChildContainer(current, seg, nextSeg);
}

const lastSeg = path[path.length - 1];
if (kind === 1) {
// Set value at key path
if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
current[Number(lastSeg)] = v;
return root;
}
if (isObject(current)) {
// Use Object.defineProperty for safe assignment, preventing prototype pollution
Object.defineProperty(current, lastSeg, {
value: v,
writable: true,
enumerable: true,
configurable: true
});
}
return root;
}

if (kind === 2) {
// Append value(s) to array at key path
let target: any;
if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
const idx = Number(lastSeg);
if (!Array.isArray(current[idx])) {
current[idx] = [];
}
target = current[idx];
} else if (isObject(current)) {
if (!Array.isArray((current as any)[lastSeg])) {
// Use Object.defineProperty for safe assignment
Object.defineProperty(current, lastSeg, {
value: [],
writable: true,
enumerable: true,
configurable: true
});
}
target = (current as any)[lastSeg];
}

if (Array.isArray(target)) {
if (Array.isArray(v)) {
target.push(...v);
} else {
target.push(v);
}
}
return root;
}

return root;
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
if (!isObject(item)) {
continue;
}
// Separate thinking items from regular response text
if ((item as any).kind === 'thinking') {
const value = (item as any).value;
if (typeof value === 'string' && value) {
thinkingText += value;
}
continue;
}
const contentValue = isObject((item as any).content) ? (item as any).content.value : undefined;
const value = (item as any).value;
// Prefer content.value when present to avoid double-counting wrapper text.
if (typeof contentValue === 'string' && contentValue) {
responseText += contentValue;
continue;
}
if (typeof value === 'string' && value) {
responseText += value;
}
}
return { responseText, thinkingText };
}

export function parseSessionFileContent(
sessionFilePath: string,
fileContent: string,
estimateTokensFromText: (text: string, model?: string) => number,
getModelFromRequest?: (req: any) => string
) {
// Aggregates and helpers are declared up front; the heavy lifting is delegated
const modelUsage: ModelUsage = {};
let interactions = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalThinkingTokens = 0;
let totalActualTokens = 0;

let sessionJson: any | undefined;
let defaultModel = 'unknown';

const ensureModel = (m?: string) => (typeof m === 'string' && m ? m : defaultModel);
const addInput = (model: string, text: string) => {
const m = ensureModel(model);
if (!modelUsage[m]) { modelUsage[m] = { inputTokens: 0, outputTokens: 0 }; }
const t = estimateTokensFromText(text, m);
modelUsage[m].inputTokens += t;
totalInputTokens += t;
};
const addOutput = (model: string, text: string) => {
const m = ensureModel(model);
if (!modelUsage[m]) { modelUsage[m] = { inputTokens: 0, outputTokens: 0 }; }
const t = estimateTokensFromText(text, m);
modelUsage[m].outputTokens += t;
totalOutputTokens += t;
};

// Process a single request (used by both JSON and reconstructed delta flows)
const processRequest = (request: any) => {
if (request == null || typeof request !== 'object') { return; }

const rawRequestModel = request.modelId ?? request.selectedModel?.identifier ?? request.model;
const requestModel = normalizeModelId(rawRequestModel, defaultModel);

let model: string;
if (typeof rawRequestModel === 'string' && rawRequestModel.trim()) {
model = requestModel;
} else {
const callbackModelRaw = getModelFromRequest ? getModelFromRequest(request) : undefined;
const callbackModel = normalizeModelId(callbackModelRaw, '');
model = callbackModel || requestModel;
}

// Input parts
if (request?.message?.parts) {
for (const part of request.message.parts) {
if (typeof part?.text === 'string' && part.text) { addInput(model, part.text); }
}
} else if (typeof request?.message?.text === 'string') {
addInput(model, request.message.text);
}

// Extract output and thinking text via extractResponseAndThinkingText, which handles
// both plain .value and delta-format content.value shapes.
const { responseText, thinkingText } = extractResponseAndThinkingText(request.response);
if (responseText) { addOutput(model, responseText); }
if (thinkingText) { totalThinkingTokens += estimateTokensFromText(thinkingText, model); }

// Loop only for sub-agents and message.parts — skip .value and thinking items
// because extractResponseAndThinkingText already counted them above.
const responseItems = Array.isArray(request.response) ? request.response : (Array.isArray(request.responses) ? request.responses : []);
for (const responseItem of responseItems) {
const subAgent = extractSubAgentData(responseItem);
if (subAgent) {
const saModel = subAgent.modelName || model;
if (subAgent.prompt) { addInput(saModel, subAgent.prompt); }
if (subAgent.result) { addOutput(saModel, subAgent.result); }
continue;
}
// .value (including thinking) already handled — skip to avoid double-counting
if (responseItem?.kind === 'thinking') { continue; }
if (typeof responseItem?.value === 'string') { continue; }

// message.parts is not covered by extractResponseAndThinkingText
if (responseItem?.message?.parts) {
for (const p of responseItem.message.parts) {
if (typeof p?.text === 'string' && p.text) { addOutput(model, p.text); }
}
}
}

// Actual token counts if present
if (request?.result?.usage) {
const u = request.result.usage;
const prompt = typeof u.promptTokens === 'number' ? u.promptTokens : 0;
const completion = typeof u.completionTokens === 'number' ? u.completionTokens : 0;
totalActualTokens += prompt + completion;
} else if (typeof request?.result?.promptTokens === 'number' && typeof request?.result?.outputTokens === 'number') {
totalActualTokens += request.result.promptTokens + request.result.outputTokens;
} else if (request?.result?.metadata && typeof request?.result?.metadata?.promptTokens === 'number' && typeof request?.result?.metadata?.outputTokens === 'number') {
totalActualTokens += request.result.metadata.promptTokens + request.result.metadata.outputTokens;
}
};

// Handle delta-based JSONL format (VS Code Insiders)
if (sessionFilePath.endsWith('.jsonl')) {
const lines = fileContent.split(/\r?\n/).filter(l => l.trim());
let isDeltaBased = false;
if (lines.length > 0) {
try { const first = JSON.parse(lines[0]); if (first && typeof first.kind === 'number') { isDeltaBased = true; } } catch {}
}

if (isDeltaBased) {
let sessionState: unknown = Object.create(null);
for (const line of lines) {
try { const delta = JSON.parse(line); sessionState = applyDelta(sessionState, delta); } catch { }
}

const requests = isObject(sessionState) && Array.isArray((sessionState as any).requests) ? ((sessionState as any).requests as unknown[]) : [];
// Count only requests that look like user interactions
interactions = requests.filter((r) => isObject(r) && isObject((r as any).message) && typeof (r as any).message.text === 'string' && (r as any).message.text.trim()).length;
for (const r of requests) { processRequest(r); }
return {
tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens,
interactions,
modelUsage,
thinkingTokens: totalThinkingTokens,
actualTokens: 0,
};
}

// Fallback: sometimes .jsonl contains a single JSON object
try { sessionJson = JSON.parse(fileContent.trim()); } catch { return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 }; }
}

// Non-jsonl (JSON file) - try to parse full JSON
if (!sessionJson) {
try { sessionJson = JSON.parse(fileContent); } catch { return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0, actualTokens: 0 }; }
}

const requests = Array.isArray(sessionJson.requests) ? sessionJson.requests : (Array.isArray(sessionJson.history) ? sessionJson.history : []);
interactions = requests.length;
for (const request of requests) { processRequest(request); }

return {
tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens,
interactions,
modelUsage,
thinkingTokens: totalThinkingTokens,
actualTokens: totalActualTokens,
};
}

export default { parseSessionFileContent };

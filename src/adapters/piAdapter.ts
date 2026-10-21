import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { PiDataAccess } from '../pi';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

export class PiAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
readonly id = 'pi';
	readonly reportsCacheReads = true;
readonly displayName = 'Pi';

constructor(private readonly pi: PiDataAccess) {}

handles(sessionFile: string): boolean {
return this.pi.isPiSessionFile(sessionFile);
}

getBackingPath(sessionFile: string): string {
return sessionFile;
}

async stat(sessionFile: string): Promise<fs.Stats> {
return fs.promises.stat(sessionFile);
}

async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
const result = await this.pi.getTokens(sessionFile);
return { ...result, actualTokens: result.tokens };
}

async countInteractions(sessionFile: string): Promise<number> {
return this.pi.countInteractions(sessionFile);
}

async getModelUsage(sessionFile: string): Promise<ModelUsage> {
return this.pi.getModelUsage(sessionFile);
}

async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
return this.pi.getSessionMeta(sessionFile);
}

getEditorRoot(_sessionFile: string): string {
return this.pi.getConfigDir();
}

async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
const candidatePaths = this.getCandidatePaths();
const sessionFiles: string[] = [];
try {
const files = await this.pi.discoverSessions();
if (files.length > 0) {
log(`📄 Found ${files.length} session file(s) in Pi (~/.pi/agent/sessions)`);
sessionFiles.push(...files);
}
} catch (e) {
log(`Could not read Pi session files: ${e}`);
}
return { sessionFiles, candidatePaths };
}

getCandidatePaths(): CandidatePath[] {
return [{ path: this.pi.getConfigDir(), source: 'Pi' }];
}

async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
const messages = await this.pi.getMessages(sessionFile);
const { tokens: actualTokens } = await this.pi.getTokens(sessionFile);
const modelUsage = await this.pi.getModelUsage(sessionFile);
const numTurns = messages.filter(e => e.message?.role === 'user').length;
const { perTurnInput, perTurnOutput } = this.computePerTurnDefaults(modelUsage, numTurns);
return { turns: this.buildAllTurns(messages, perTurnInput, perTurnOutput), actualTokens };
}

private computePerTurnDefaults(modelUsage: ModelUsage, numTurns: number): { perTurnInput: number; perTurnOutput: number } {
if (numTurns === 0) { return { perTurnInput: 0, perTurnOutput: 0 }; }
const totalInput = Object.values(modelUsage).reduce((sum, u) => sum + u.inputTokens, 0);
const totalOutput = Object.values(modelUsage).reduce((sum, u) => sum + u.outputTokens, 0);
return { perTurnInput: Math.round(totalInput / numTurns), perTurnOutput: Math.round(totalOutput / numTurns) };
}

private buildAllTurns(messages: any[], perTurnInput: number, perTurnOutput: number): ChatTurn[] {
const turns: ChatTurn[] = [];
let turnNumber = 0;
for (let i = 0; i < messages.length; i++) {
if (messages[i].message?.role !== 'user') { continue; }
turnNumber++;
const assistantEvents = this.collectAssistantEvents(messages, i);
turns.push(this.buildTurn(messages[i], assistantEvents, turnNumber, perTurnInput, perTurnOutput));
}
return turns;
}

private collectAssistantEvents(messages: any[], userIdx: number): any[] {
const result: any[] = [];
for (let j = userIdx + 1; j < messages.length; j++) {
if (messages[j].message?.role === 'user') { break; }
if (messages[j].message?.role === 'assistant') { result.push(messages[j]); }
}
return result;
}

private buildTurn(userEvent: any, assistantEvents: any[], turnNumber: number, perTurnInput: number, perTurnOutput: number): ChatTurn {
const userText = this.extractUserText(userEvent.message?.content);
const { assistantText, toolCalls, model } = this.processAssistantEvents(assistantEvents);
// Sum all assistant events' usage — agentic sessions make many API calls per turn,
// each with its own (growing) context window; taking only the last under-counts heavily.
const totalInput = assistantEvents.reduce((sum, e) => sum + (e.message?.usage?.input ?? 0), 0);
const totalOutput = assistantEvents.reduce((sum, e) => sum + (e.message?.usage?.output ?? 0), 0);
return {
turnNumber,
timestamp: userEvent.timestamp ?? null,
mode: 'cli',
userMessage: userText,
assistantResponse: assistantText,
model,
toolCalls,
contextReferences: createEmptyContextRefs(),
mcpTools: [],
inputTokensEstimate: totalInput > 0 ? totalInput : perTurnInput,
outputTokensEstimate: totalOutput > 0 ? totalOutput : perTurnOutput,
thinkingTokensEstimate: 0,
};
}

private extractUserText(content: any): string {
if (Array.isArray(content)) {
return content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('\n');
}
return typeof content === 'string' ? content : '';
}

private processAssistantEvents(assistantEvents: any[]): {
assistantText: string;
toolCalls: { toolName: string; arguments?: string; result?: string }[];
model: string | null;
} {
let assistantText = '';
const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
let model: string | null = null;
for (const event of assistantEvents) {
const msg = event.message;
if (!model) { model = msg?.model ?? null; }
if (Array.isArray(msg?.content)) {
assistantText += this.processContentParts(msg.content, toolCalls);
}
}
return { assistantText, toolCalls, model };
}

private processContentParts(
content: any[],
toolCalls: { toolName: string; arguments?: string; result?: string }[]
): string {
let text = '';
for (const part of content) {
if (part.type === 'text' && part.text) { text += part.text; }
else if (part.type === 'toolCall' && part.name) {
toolCalls.push({ toolName: part.name, arguments: part.arguments ? JSON.stringify(part.arguments) : undefined });
}
}
return text;
}

async getSyncData(sessionFile: string): Promise<{ tokens: number; interactions: number; modelUsage: ModelUsage; timestamp: number }> {
return this.pi.getSessionData(sessionFile);
}

async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
const analysis = createEmptySessionUsageAnalysis();
const messages = await this.pi.getMessages(sessionFile);
const models = this.collectModelsAndCounts(messages, analysis);
this.applyModelSwitchingStats(models, ctx, analysis);
return analysis;
}

private collectModelsAndCounts(messages: any[], analysis: import('../types').SessionUsageAnalysis): string[] {
const models: string[] = [];
for (const event of messages) {
const msg = event.message;
if (!msg) { continue; }
if (msg.role === 'user') { analysis.modeUsage.cli++; }
else if (msg.role === 'assistant') { this.processAssistantForAnalysis(msg, models, analysis); }
}
return models;
}

private processAssistantForAnalysis(msg: any, models: string[], analysis: import('../types').SessionUsageAnalysis): void {
models.push(msg.model || 'unknown');
if (!Array.isArray(msg.content)) { return; }
for (const part of msg.content) {
if (part.type === 'toolCall' && part.name) {
analysis.toolCalls.total++;
const toolName = part.name as string;
analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
}
}
}

private applyModelSwitchingStats(models: string[], ctx: UsageAnalysisAdapterContext, analysis: import('../types').SessionUsageAnalysis): void {
const uniqueModels = [...new Set(models)];
analysis.modelSwitching.uniqueModels = uniqueModels;
analysis.modelSwitching.modelCount = uniqueModels.length;
analysis.modelSwitching.totalRequests = models.length;
let switchCount = 0;
for (let i = 1; i < models.length; i++) {
if (models[i] !== models[i - 1]) { switchCount++; }
}
analysis.modelSwitching.switchCount = switchCount;
applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);
}
}

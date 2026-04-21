/**
 * IEcosystemAdapter — common interface for all supported editor/ecosystem data-access adapters.
 *
 * Every supported ecosystem (OpenCode, Crush, Continue, Claude Code, Claude Desktop Cowork,
 * Visual Studio, Mistral Vibe) implements this interface. A registry of adapters replaces the
 * repeated if-statement chains in extension.ts, usageAnalysis.ts, and cli/src/helpers.ts.
 *
 * Adding a new ecosystem only requires:
 *   1. Implementing this interface in a new file under src/adapters/
 *   2. Adding an instance to the registry in extension.ts (and cli/src/helpers.ts)
 */
import type * as fsModule from 'fs';
import type { ModelUsage, ChatTurn } from './types';

export interface IEcosystemAdapter {
	/** Stable lowercase identifier, e.g. 'opencode', 'crush', 'continue'. */
	readonly id: string;
	/** Human-readable display name, e.g. 'OpenCode', 'Crush', 'Continue'. */
	readonly displayName: string;

	/** Returns true if this adapter owns the given session file path. */
	handles(sessionFile: string): boolean;

	/**
	 * Returns the real filesystem path that backs this session file.
	 * For regular files this is sessionFile itself.
	 * For virtual DB paths (e.g. crush.db#<uuid>) this is the underlying .db file.
	 * Used for fs.existsSync() checks and cache fingerprinting.
	 */
	getBackingPath(sessionFile: string): string;

	/** Stat the backing file for this session (handles virtual DB paths). */
	stat(sessionFile: string): Promise<fsModule.Stats>;

	/** Get token counts for the session. actualTokens equals tokens (no separate real-API tracking). */
	getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }>;

	/** Count user interactions in the session. */
	countInteractions(sessionFile: string): Promise<number>;

	/** Get per-model token usage breakdown. */
	getModelUsage(sessionFile: string): Promise<ModelUsage>;

	/**
	 * Extract session metadata.
	 * workspacePath is the raw cwd / workspace directory path if known by this ecosystem.
	 */
	getMeta(sessionFile: string): Promise<{
		title: string | undefined;
		firstInteraction: string | null;
		lastInteraction: string | null;
		workspacePath?: string;
	}>;

	/**
	 * Root path for this editor's session storage (used in diagnostics display).
	 * e.g. for OpenCode: ~/.local/share/opencode
	 * e.g. for Crush: the project's .crush/ directory
	 */
	getEditorRoot(sessionFile: string): string;

	/**
	 * Build chat turns for the log viewer (Phase 2 — optional).
	 * When present, getSessionLogData() can use this instead of its own if-chain.
	 */
	buildTurns?(sessionFile: string): Promise<ChatTurn[]>;
}

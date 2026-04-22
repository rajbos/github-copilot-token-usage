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
	/**
	 * When true, backend sync is skipped for sessions handled by this adapter
	 * (e.g. Visual Studio binary MessagePack sessions cannot be synced).
	 */
	readonly skipBackendSync?: boolean;

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
	 * Build chat turns for the log viewer.
	 * Returns turns plus optional actualTokens (only MistralVibe has session-level actual usage).
	 * When absent, getSessionLogData() falls through to the built-in Copilot Chat parser.
	 */
	buildTurns?(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }>;

	/**
	 * Return the raw decoded content of the session file as a string.
	 * Only needed for binary formats (e.g. Visual Studio MessagePack).
	 * When absent, the caller reads the file directly.
	 */
	getRawFileContent?(sessionFile: string): string | undefined;

	/**
	 * Return data needed for backend sync.
	 * Only implemented by ecosystems that support sync (OpenCode, Crush).
	 */
	getSyncData?(sessionFile: string): Promise<{
		tokens: number;
		interactions: number;
		modelUsage: ModelUsage;
		timestamp: number;
	}>;
}

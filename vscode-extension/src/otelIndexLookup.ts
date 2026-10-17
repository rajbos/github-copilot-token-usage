/**
 * Answers the analysis workers' "what does the OTel export say about this session?" questions from the host's one
 * index, without each question reading or waiting on the index itself.
 *
 * While the index is still being built, a question waits briefly for the ready event (a restored snapshot is ready in
 * well under a second) and otherwise fails at once, remembering that it did. When the index announces it is ready, the
 * owner is told once, and refreshes the sessions that failed. Nothing polls and nothing queues behind the build.
 */
import {
	getCopilotCliOtelUsage,
	onCopilotCliOtelIndexReady,
	whenCopilotCliOtelIndexReady,
	type CopilotCliOtelSessionUsage,
} from '../../src/copilotCliOtel';

export interface WorkerOtelLookupDeps {
	whenReady: (timeoutMs: number) => Promise<boolean>;
	onReady: (listener: () => void) => () => void;
	getUsage: (sessionFile: string) => Promise<CopilotCliOtelSessionUsage | null>;
}

const REAL_DEPS: WorkerOtelLookupDeps = {
	whenReady: whenCopilotCliOtelIndexReady,
	onReady: onCopilotCliOtelIndexReady,
	getUsage: getCopilotCliOtelUsage,
};

export interface WorkerOtelLookup {
	resolve(sessionFile: string): Promise<CopilotCliOtelSessionUsage | null>;
	dispose(): void;
}

/**
 * @param waitMs how long a question waits for an index that is still being built
 * @param onReadyAfterMisses called once when the index becomes ready, if any question failed because it was not
 */
export function createWorkerOtelLookup(waitMs: number, onReadyAfterMisses: () => void, deps: WorkerOtelLookupDeps = REAL_DEPS): WorkerOtelLookup {
	let missed = false;
	const unsubscribe = deps.onReady(() => {
		if (!missed) { return; }
		missed = false;
		onReadyAfterMisses();
	});
	return {
		async resolve(sessionFile) {
			if (!(await deps.whenReady(waitMs))) {
				missed = true;
				throw new Error('the OTel index is still being built; this session is refreshed when it is ready');
			}
			return deps.getUsage(sessionFile);
		},
		dispose: unsubscribe,
	};
}

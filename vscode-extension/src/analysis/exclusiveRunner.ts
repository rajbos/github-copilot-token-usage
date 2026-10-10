/**
 * Runs async tasks strictly one after another. A rejection in one task is reported to its own caller only and
 * does not stop later tasks from running.
 */
export class ExclusiveRunner {
	private chain: Promise<void> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.chain.then(task);
		this.chain = result.then(() => undefined, () => undefined);
		return result;
	}
}

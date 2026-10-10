/**
 * AI Engineering Fluency CLI
 *
 * Command-line interface for analyzing AI coding tool token usage
 * from local session files. Can be run via `npx @rajbos/ai-engineering-fluency`.
 */
import { createProgram } from './program';

// parseAsync, not parse: `memory-files --server/--promote` has an async action handler, and
// Commander does not await async handlers through parse(). Without this the command can
// finish outside the CLI lifecycle and a rejected promise would surface as an unhandled
// rejection rather than a non-zero exit with a readable message.
createProgram().parseAsync().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

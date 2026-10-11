/**
 * Builds the CLI's root Commander program: global options, cache hooks and every
 * sub-command. Kept separate from cli.ts (which parses process.argv on load) so
 * tests can inspect the exact command/option registry the executable uses.
 */
import { Command } from 'commander';
import { statsCommand } from './commands/stats';
import { usageCommand } from './commands/usage';
import { environmentalCommand } from './commands/environmental';
import { fluencyCommand } from './commands/fluency';
import { diagnosticsCommand } from './commands/diagnostics';
import { chartCommand } from './commands/chart';
import { usageAnalysisCommand } from './commands/usageAnalysis';
import { allCommand } from './commands/all';
import { segmentCommand } from './commands/segment';
import { curationCommand } from './commands/curation';
import { memoryFilesCommand } from './commands/memory-files';
import { skillSuggestionsCommand } from './commands/skill-suggestions';
import { loadCache, saveCache, disableCache } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('../package.json');

export function createProgram(): Command {
	const program = new Command();

	program
		.name('ai-engineering-fluency')
		.description('Analyze token usage, cost and fluency from local AI coding session files')
		.version(packageJson.version)
		.option('--no-cache', 'Bypass the session file cache and re-parse everything');

	// Initialise / tear-down cache around every sub-command
	program.hook('preAction', () => {
		if (program.opts().cache === false) {
			disableCache();
		} else {
			loadCache();
		}
	});
	program.hook('postAction', () => {
		saveCache();
	});

	program.addCommand(statsCommand);
	program.addCommand(usageCommand);
	program.addCommand(environmentalCommand);
	program.addCommand(fluencyCommand);
	program.addCommand(diagnosticsCommand);
	program.addCommand(chartCommand);
	program.addCommand(usageAnalysisCommand);
	program.addCommand(allCommand);
	program.addCommand(segmentCommand);
	program.addCommand(curationCommand);
	program.addCommand(memoryFilesCommand);
	program.addCommand(skillSuggestionsCommand);

	return program;
}

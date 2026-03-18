/**
 * Copilot Token Tracker CLI
 *
 * Command-line interface for analyzing GitHub Copilot token usage
 * from local session files. Can be run via `npx copilot-token-tracker-cli`.
 */
import { Command } from 'commander';
import { statsCommand } from './commands/stats';
import { usageCommand } from './commands/usage';
import { environmentalCommand } from './commands/environmental';
import { fluencyCommand } from './commands/fluency';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('../package.json');

const program = new Command();

program
	.name('copilot-token-tracker')
	.description('Analyze GitHub Copilot token usage from local session files')
	.version(packageJson.version);

program.addCommand(statsCommand);
program.addCommand(usageCommand);
program.addCommand(environmentalCommand);
program.addCommand(fluencyCommand);

program.parse();

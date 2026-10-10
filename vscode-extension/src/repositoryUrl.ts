/**
 * Repository URL lookup for the VS Code extension.
 * Lives in the extension layer (not the shared src/ layer) because it reads
 * the extension's own package.json.
 */
import * as packageJson from '../package.json';

// Helper method to get repository URL from package.json
export function getRepositoryUrl(): string {
	const repoUrl = packageJson.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
	return repoUrl || 'https://github.com/rajbos/ai-engineering-fluency';
}

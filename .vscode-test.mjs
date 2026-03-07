import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
	mocha: {
		timeout: 60000,
		parallel: false
	}
});

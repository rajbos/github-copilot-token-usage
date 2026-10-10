/**
 * Injected into the library bundle only (esbuild.js `define: { console: ... }`): shared parsing
 * code logs recoverable problems with console.error, which is right for the CLI and the
 * extension but not for a library embedded in someone else's app. Every bundled `console`
 * reference resolves to this no-op object instead; the host's global console is untouched.
 */
const noop = (): void => { /* library is silent */ };
export const __aiFluencySilentConsole: Console = new Proxy({} as Console, { get: () => noop });

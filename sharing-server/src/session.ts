import { createHmac, timingSafeEqual } from 'crypto';
import { SESSION_MAX_AGE_SECONDS } from './config.js';

/** Insecure fallback used outside production only. Public in the source, so it must never sign a production cookie. */
export const DEV_SESSION_SECRET = 'dev-secret-change-me-in-production';
export const MIN_SESSION_SECRET_LENGTH = 32;
export const COOKIE_NAME = 'sharing-session';
export const OAUTH_STATE_COOKIE = 'oauth-state';

/** Minimal claims stored in the session cookie. User details are re-read from DB on every request. */
export interface SessionClaims {
	sub: number;  // users.id (internal DB id, not github_id)
	iat: number;  // issued-at (epoch seconds)
	exp: number;  // expires-at (epoch seconds)
}

/**
 * Throw if `env` is a production environment without a usable SESSION_SECRET.
 *
 * Admin status is looked up by the cookie's `sub`, so a guessable signing secret means
 * a forgeable admin session. Called from `createApp` and `startServer` (before listening)
 * and again whenever a cookie is signed or verified, so embedders that bypass either entry
 * point still cannot run production on the dev fallback. Evaluated lazily, never at import.
 */
export function assertSessionSecretConfigured(env: NodeJS.ProcessEnv = process.env): void {
	if (env.NODE_ENV !== 'production') return;
	const secret = env.SESSION_SECRET;
	const problem = !secret ? 'is not set'
		: secret === DEV_SESSION_SECRET ? 'is the insecure development default'
		: secret.length < MIN_SESSION_SECRET_LENGTH ? `is shorter than ${MIN_SESSION_SECRET_LENGTH} characters`
		: undefined;
	if (problem) {
		throw new Error(
			`SESSION_SECRET ${problem}. Refusing to run with NODE_ENV=production: session cookies would be forgeable. ` +
			`Set SESSION_SECRET to a random value of at least ${MIN_SESSION_SECRET_LENGTH} characters, e.g. ` +
			`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
		);
	}
}

let devSecretWarned = false;

/** Resolve the signing secret; outside production falls back to the dev default with a one-time warning. */
function getSessionSecret(): string {
	assertSessionSecretConfigured();
	const secret = process.env.SESSION_SECRET;
	if (secret) return secret;
	if (!devSecretWarned) {
		devSecretWarned = true;
		console.warn('[session] SESSION_SECRET is not set; using the insecure development default. Set SESSION_SECRET before deploying.');
	}
	return DEV_SESSION_SECRET;
}

function sign(payload: string): string {
	return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

export function encodeSession(claims: SessionClaims): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const signature = sign(payload);
	return `${payload}.${signature}`;
}

export function decodeSession(cookie: string): SessionClaims | null {
	const dotIndex = cookie.lastIndexOf('.');
	if (dotIndex < 0) return null;
	const payload = cookie.slice(0, dotIndex);
	const signature = cookie.slice(dotIndex + 1);

	const expected = sign(payload);
	try {
		const sigBuf = Buffer.from(signature, 'base64url');
		const expBuf = Buffer.from(expected, 'base64url');
		if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
			return null;
		}
	} catch {
		return null;
	}

	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionClaims;
		// Reject expired sessions
		if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) {
			return null;
		}
		return claims;
	} catch {
		return null;
	}
}

export function makeClaims(userId: number): SessionClaims {
	const now = Math.floor(Date.now() / 1000);
	return { sub: userId, iat: now, exp: now + SESSION_MAX_AGE_SECONDS };
}

export const SESSION_MAX_AGE = SESSION_MAX_AGE_SECONDS;

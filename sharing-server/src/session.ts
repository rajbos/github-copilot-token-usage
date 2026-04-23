import { createHmac, timingSafeEqual } from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-change-me-in-production';
export const COOKIE_NAME = 'sharing-session';
export const OAUTH_STATE_COOKIE = 'oauth-state';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** Minimal claims stored in the session cookie. User details are re-read from DB on every request. */
export interface SessionClaims {
	sub: number;  // users.id (internal DB id, not github_id)
	iat: number;  // issued-at (epoch seconds)
	exp: number;  // expires-at (epoch seconds)
}

function sign(payload: string): string {
	return createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
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
	return { sub: userId, iat: now, exp: now + MAX_AGE_SECONDS };
}

export const SESSION_MAX_AGE = MAX_AGE_SECONDS;

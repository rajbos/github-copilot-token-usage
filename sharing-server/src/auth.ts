import { createHash } from 'crypto';
import type { Context, Next } from 'hono';
import { upsertUser, type UserRow } from './db.js';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedAuth {
	user: UserRow;
	expiresAt: number;
}

interface NegativeCacheEntry {
	bannedUntil: number;
}

// Token validation cache: SHA-256(token) → { user, expiresAt }
const tokenCache = new Map<string, CachedAuth>();

// Negative cache: SHA-256(token) → bannedUntil timestamp (short TTL for bad tokens)
const negativeCache = new Map<string, NegativeCacheEntry>();
const NEGATIVE_TTL_MS = 60 * 1000; // 1 minute

// Upload rate limiter: github_id → { count, resetAt }
const uploadRateMap = new Map<number, { count: number; resetAt: number }>();
const UPLOAD_RATE_MAX = 100;
const UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour per user

// Pre-auth IP rate limiter: IP → { count, resetAt }
const ipRateMap = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_MAX = 200;
const IP_RATE_WINDOW_MS = 60 * 1000; // 1 minute per IP

/**
 * Validates a GitHub Bearer token supplied by the client (e.g. the VS Code extension).
 * Resolves the token to a local user row, or returns null if the token is invalid,
 * the GitHub API is unreachable, or the user is not a member of ALLOWED_GITHUB_ORG.
 *
 * Results are cached for 10 minutes (positive) or 1 minute (negative) to reduce
 * outbound GitHub API calls.
 */
export async function validateGitHubToken(token: string): Promise<UserRow | null> {
	const cacheKey = createHash('sha256').update(token).digest('hex');

	// Check negative cache first
	const negative = negativeCache.get(cacheKey);
	if (negative && negative.bannedUntil > Date.now()) {
		return null;
	}

	// Check positive cache
	const cached = tokenCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.user;
	}

	let response: Response;
	try {
		response = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: `Bearer ${token}`,
				'User-Agent': 'copilot-sharing-server/1.0',
				Accept: 'application/vnd.github+json',
			},
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		// Network error — don't cache, let the caller retry
		return null;
	}

	if (!response.ok) {
		negativeCache.set(cacheKey, { bannedUntil: Date.now() + NEGATIVE_TTL_MS });
		return null;
	}

	const data = await response.json() as { id: number; login: string; name: string | null; avatar_url: string };

	// Optional org membership check
	const allowedOrg = process.env.ALLOWED_GITHUB_ORG;
	if (allowedOrg) {
		const isMember = await checkOrgMembership(token, data.login, allowedOrg);
		if (!isMember) {
			negativeCache.set(cacheKey, { bannedUntil: Date.now() + NEGATIVE_TTL_MS });
			return null;
		}
	}

	const user = upsertUser(data.id, data.login, data.name, data.avatar_url);

	tokenCache.set(cacheKey, { user, expiresAt: Date.now() + CACHE_TTL_MS });
	return user;
}

/**
 * Checks whether `username` is an active public member of `org`.
 *
 * Uses GITHUB_ORG_CHECK_TOKEN (a server-configured PAT) when set, so that the
 * check works even when the org enforces SAML SSO — the server operator's PAT
 * is pre-authorized for the org, meaning the end user's token never needs
 * read:org scope or SSO authorization.
 *
 * Falls back to the user's own token if no server PAT is configured (works for
 * orgs with public membership and no SAML enforcement).
 */
async function checkOrgMembership(userToken: string, username: string, org: string): Promise<boolean> {
	// Prefer a server-side PAT (already SSO-authorized) so the user's OAuth token
	// doesn't need read:org or SAML SSO authorization.
	const checkToken = process.env.GITHUB_ORG_CHECK_TOKEN || userToken;
	try {
		const res = await fetch(`https://api.github.com/orgs/${org}/members/${username}`, {
			headers: {
				Authorization: `Bearer ${checkToken}`,
				'User-Agent': 'copilot-sharing-server/1.0',
				Accept: 'application/vnd.github+json',
			},
			signal: AbortSignal.timeout(10_000),
		});
		return res.status === 204;
	} catch {
		return false;
	}
}

/** Returns true if the IP address is within the pre-auth rate limit window, false if it should be blocked. */
export function checkIpRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = ipRateMap.get(ip);
	if (!entry || entry.resetAt <= now) {
		ipRateMap.set(ip, { count: 1, resetAt: now + IP_RATE_WINDOW_MS });
		return true;
	}
	if (entry.count >= IP_RATE_MAX) return false;
	entry.count++;
	return true;
}

/** Returns true if the user is within the upload rate limit window, false if they should be blocked. */
export function checkUploadRateLimit(userId: number): boolean {
	const now = Date.now();
	const entry = uploadRateMap.get(userId);
	if (!entry || entry.resetAt <= now) {
		uploadRateMap.set(userId, { count: 1, resetAt: now + UPLOAD_RATE_WINDOW_MS });
		return true;
	}
	if (entry.count >= UPLOAD_RATE_MAX) return false;
	entry.count++;
	return true;
}

export type AuthVariables = { user: UserRow };

/**
 * Hono middleware that enforces Bearer token authentication on API routes.
 * Applies IP-level rate limiting before token validation, then resolves the
 * token to a user and stores it in the Hono context for downstream handlers.
 */
export async function requireBearerAuth(c: Context, next: Next): Promise<Response | void> {
	const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';

	if (!checkIpRateLimit(ip)) {
		return c.json({ error: 'Too many requests' }, 429);
	}

	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const token = authHeader.slice(7);
	if (!token) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const user = await validateGitHubToken(token);
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	c.set('user', user);
	await next();
}

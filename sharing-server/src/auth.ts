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

async function checkOrgMembership(token: string, username: string, org: string): Promise<boolean> {
	try {
		const res = await fetch(`https://api.github.com/orgs/${org}/members/${username}`, {
			headers: {
				Authorization: `Bearer ${token}`,
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

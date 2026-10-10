/**
 * Public entry point for `@rajbos/ai-engineering-fluency-sharing-server`.
 *
 * Downstream servers compose this package instead of forking it:
 *
 * ```ts
 * import { createApp, startServer, registerSchemaExtension, requireBearerAuth } from '@rajbos/ai-engineering-fluency-sharing-server';
 *
 * registerSchemaExtension('vendor', (db) => db.exec(`CREATE TABLE IF NOT EXISTS ...`));
 *
 * const app = createApp({ extend: (a) => a.route('/api/vendor', vendorRoutes) });
 * await startServer(app);
 * ```
 */

export { createApp, type CreateAppOptions } from './app.js';
export { renderNavExtra, navExtraMiddleware, type NavLink, type NavVariables } from './nav.js';
export {
	startServer,
	initDbWithRetry,
	registerShutdownHandlers,
	type StartServerOptions,
} from './lifecycle.js';

// Built-in route apps, so a downstream server can remount them under a different path.
export { api } from './routes/api.js';
export { dashboard } from './routes/dashboard.js';

// Reuse the member-safe projection rather than exposing admin queries to team members.
export {
	getTeamInsights,
	parseTeamDays,
	type TeamInsights,
	type TeamMember,
	type UsageCohort,
} from './teamInsights.js';

// Auth — reuse so downstream endpoints authenticate the *same* user as core uploads.
// This is what makes the two datasets joinable on `user_id`.
export {
	requireBearerAuth,
	validateGitHubToken,
	checkIpRateLimit,
	checkUploadRateLimit,
	type AuthVariables,
} from './auth.js';

export {
	COOKIE_NAME,
	OAUTH_STATE_COOKIE,
	SESSION_MAX_AGE,
	encodeSession,
	decodeSession,
	makeClaims,
	type SessionClaims,
} from './session.js';

export {
	getDb,
	closeDb,
	registerSchemaExtension,
	restoreFromBackup,
	backupToAzureFiles,
	syncAdminLogins,
	upsertUser,
	getUserById,
	getUserByGithubId,
	upsertUpload,
	deleteUploadsForDays,
	getUploadsForUser,
	getAllUsers,
	getAllUploads,
	upsertUserFluencyScore,
	getUserFluencyScore,
	getAdminUserSummaries,
	getAdminDailyTotals,
	type SchemaExtension,
	type UserRow,
	type UserUsageSummary,
	type AdminDailyRow,
	type UploadRow,
	type AdminUploadRow,
	type UploadEntry,
} from './db.js';

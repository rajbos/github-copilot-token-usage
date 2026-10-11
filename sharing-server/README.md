# AI Engineering Fluency — Sharing Server

A self-hosted API server + web dashboard that makes sharing AI Engineering Fluency data
across a team dramatically easier. No Azure account required — anyone with Docker can
host it in minutes.

Development, testing and downstream customization must follow the
[data separation contract](https://github.com/rajbos/ai-engineering-fluency/blob/main/sharing-server/AGENTS.md)
(`sharing-server/AGENTS.md` in this repository, also shipped as `AGENTS.md` in
the published npm package).

## How it works

```
[VS Code Extension]  ──Bearer token──►  POST /api/upload
                         (GitHub session)       │
                                        [Sharing Server]
                                               │
                                         SQLite DB (./data/)
                                               │
[Web Browser]  ──OAuth login──►  GET /dashboard
```

The dashboard pages are responsive: sign in from a phone browser and the header,
stat cards, charts and upload breakdown reflow to fit the screen.

**The extension already holds a GitHub OAuth session** (the same one used by Copilot
and GitHub PR statistics). When you configure a sharing server endpoint URL, the
extension automatically uses that token for uploads — no API keys, no copy-paste,
no new consent required.

## Quick start with Docker Compose

### 1. Create a GitHub OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in:
   - **Application name**: `AI Engineering Fluency`
   - **Homepage URL**: `https://your-server.example.com`
   - **Authorization callback URL**: `https://your-server.example.com/auth/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**

### 2. Create the compose file

```yaml
services:
  sharing-server:
    image: ghcr.io/rajbos/copilot-sharing-server:latest
    ports:
      - "3000:3000"
    environment:
      - GITHUB_CLIENT_ID=your_client_id
      - GITHUB_CLIENT_SECRET=your_client_secret
      - SESSION_SECRET=${SESSION_SECRET:?Missing SESSION_SECRET}
      - BASE_URL=https://your-server.example.com
      # Optional: restrict uploads to members of a specific GitHub org
      # - ALLOWED_GITHUB_ORG=your-org-name
    volumes:
      - sharing_data:/data
    restart: unless-stopped

volumes:
  sharing_data:
```

> **Tip**: Generate `SESSION_SECRET` with `openssl rand -base64 48` in bash, or in PowerShell:
``` powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
($bytes | ForEach-Object { $_.ToString("x2") }) -join '' | Set-Content -Path .session_secret.txt
Get-Content .session_secret.txt
```

### 3. Start and verify

```bash
docker compose up -d
curl https://your-server.example.com/health
# → {"status":"ok","timestamp":"..."}
```

### 4. Configure the VS Code extension

In VS Code settings (JSON):

```json
{
  "aiEngineeringFluency.backend.sharingServer.enabled": true,
  "aiEngineeringFluency.backend.sharingServer.endpointUrl": "https://your-server.example.com"
}
```

Or search for **AI Engineering Fluency: Backend** in the Settings UI and fill in the fields.

That's it. The extension will start uploading data automatically. No authentication
prompt — it reuses your existing GitHub session.

## Building from source

For code changes, also run the [server validation checks](../docs/VALIDATION.md#sharing-server)
and satisfy the data separation contract's HTTP/HTML privacy tests.
The root `.\build.ps1 -Project sharing -Target test` runs the server's `pnpm test`;
run the type/build/headless interaction checks separately as described there.

```bash
# From the repo root:
./build.ps1 -Project sharing

# Or from the sharing-server/ directory:
cd sharing-server
pnpm install --frozen-lockfile
pnpm run build            # development build
pnpm run build:production # minified build
```

## Running locally (without Docker)

### 1. Install dependencies

```bash
cd sharing-server
pnpm install --frozen-lockfile
```

### 2. Create a `.env` file

Copy the example and fill in your values:

```bash
cp .env.example .env
```

Minimum required in `.env`:

```env
GITHUB_CLIENT_ID=your_github_oauth_app_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_app_client_secret
# Generate with: openssl rand -base64 48
SESSION_SECRET=
BASE_URL=http://localhost:3000
PORT=3000
DB_PATH=./data/sharing.db
```

> **GitHub OAuth App callback URL** for local dev: `http://localhost:3000/auth/github/callback`

### 3. Build and start

```bash
pnpm run build   # compile TypeScript → dist/server.js
npm start       # start the server (automatically loads .env via Node --env-file)
```

Or for **watch mode** (auto-restarts `dist/server.js` whenever it changes):

```bash
pnpm run dev
```

> Run `pnpm run build` in a separate terminal to rebuild after editing `src/`. The `dev`
> script uses `node --watch` which restarts automatically when `dist/server.js` changes.

### 4. Verify

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

For manual verification, open `http://localhost:3000/dashboard` in your browser
to test the OAuth login flow. Automated tests use isolated SQLite fixtures and
stubbed GitHub access, never production data or live GitHub; see the
[required validation contract](AGENTS.md#required-validation).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | GitHub OAuth App client ID (for dashboard login) |
| `GITHUB_CLIENT_SECRET` | ✅ | GitHub OAuth App client secret (for dashboard login) |
| `SESSION_SECRET` | ✅ | Random secret for signing session cookies (≥32 chars). **Required when `NODE_ENV=production`** (the Docker image default): the server refuses to start, and `createApp()` throws, if it is missing, shorter than 32 characters, or the built-in dev default. Outside production an insecure dev fallback is used with a warning |
| `BASE_URL` | ✅ | Public base URL of the server (no trailing slash) |
| `PORT` | ❌ | HTTP port (default: `3000`) |
| `DB_PATH` | ❌ | SQLite database path (default: `/data/sharing.db`) |
| `ALLOWED_GITHUB_ORG` | ❌ | If set, only members of this GitHub org can upload data |
| `ADMIN_GITHUB_LOGINS` | ❌ | Comma-separated GitHub logins to auto-grant admin access (e.g. `alice,bob`). When set, this list is authoritative: listed users get admin, all others do not. Leave unset to manage admins manually via SQLite. |

## REST API

### Upload daily rollups (used by the VS Code extension)

```
POST /api/upload
Authorization: Bearer <github-token>
Content-Type: application/json

[
  {
    "day": "2026-04-21",
    "model": "gpt-4o",
    "workspaceId": "my-project",
    "workspaceName": "My Project",
    "machineId": "laptop-abc123",
    "machineName": "My Laptop",
    "editor": "Copilot CLI (App)",
    "inputTokens": 15000,
    "outputTokens": 8000,
    "interactions": 42,
    "datasetId": "default"
  }
]
```

Accepts up to **500 entries per request**. The server upserts by
`(user_id, dataset_id, day, model, workspace_id, machine_id, editor)` so repeated
uploads are safe and idempotent.

### Other endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Health check |
| `GET` | `/api/me` | Bearer token | Current user info |
| `GET` | `/api/data?days=30` | Bearer token | Own usage data (last N days) |
| `GET` | `/auth/github` | Public | Dashboard login (OAuth redirect) |
| `GET` | `/auth/github/callback` | Public | OAuth callback |
| `GET` | `/auth/logout` | Session | Clear session |
| `GET` | `/dashboard` | Session cookie | Web dashboard |
| `GET` | `/team?days=30` | Session cookie | Identity-free Team Insights page |
| `GET` | `/team/export?days=30&format=csv` | Session cookie | Team Insights download (`csv` or `json`), using the same safe projection |
| `GET` | `/api/team-insights?days=30` | Bearer token | Identity-free team totals and own comparison |

### Team Insights

`/team` and `/api/team-insights` accept `days=7`, `days=30` or `days=90`.
Omitted, malformed or unsupported values default to 30.
Each window covers exactly N UTC calendar dates including today, beginning N−1
dates ago; future-dated uploads are excluded.

Team Insights shows exact numeric period totals for anonymous active members,
marks your own row, and compares your input + output tokens with active uploaders:
rank, share of team tokens, percentile and a **Light / Medium / Heavy / Very heavy**
usage cohort. Registered users without positive tokens or interactions in the
window are not active members. If you are inactive, your `self` row has zero
numeric totals/activity/share and `rank`, `percentile` and `cohort` are `null`;
you are excluded from `members`.
Only aggregate team and your own daily trends are exposed, never peer daily series.

Period filters are full-page `/team?days=N` links and work without JavaScript.
The page includes cohort counts/thresholds, an exact numeric member table and
expandable exact daily team/own totals. Trend modes compare your own line with
either team totals or the team average per **daily active uploader**, not all
registered users or the entire period's active-member count.
The personal and admin dashboards abbreviate token counts as K, M or B,
including chart ticks and tooltips; Team Insights keeps exact values in its
numeric tables and exports.
The page footer shows the sharing-server package version alongside the
deployment branch, commit and timestamp, so a deployed instance can be
compared with the published npm version.

Download the selected period with cookie-authenticated
`/team/export?days=N&format=csv` or `format=json` (N is 7, 30 or 90).
Both formats use the same safe Team Insights projection; exports do not add
peer identities, metadata or per-peer daily data.

Tied token totals have the same rank and cohort. Cohorts use interpolated
p25/p50/p75 thresholds with `<=` boundaries; percentile counts only other active
uploaders with strictly lower totals, and is undefined when there are no peers.
These are relative usage groups, not productivity ratings. See the
[authoritative comparison definitions](AGENTS.md#period-and-comparison-semantics).
If team tokens total zero, `sharePercent` is `0` and the UI displays `0.0%` by
convention, rather than claiming a mathematically defined share.

**Anonymous labels remove direct identifiers, not all re-identification risk.**
Exact totals and small-team comparisons can reveal identity; there is no
minimum team size or suppression. Peer responses are an explicit numeric
allowlist plus self flags and calculated comparisons/cohorts, not uploaded rows.
The [data separation contract](AGENTS.md#team-projection) applies to API JSON,
HTML, embedded scripts, chart data and any new exports. Personal uploaded data
remains owner-only; named member detail remains server-authorized admin-only.
Admins using member surfaces receive the same identity-free team shape.
Personalized and team responses use `Cache-Control: private, no-store`.

#### Team Insights JSON response

The API returns the following explicit projection (the server keeps grouping IDs
internal):

| Field | Contents |
|---|---|
| `days`, `startDay`, `endDay` | Selected duration and inclusive UTC date bounds |
| `summary` | `activeUsers`, `inputTokens`, `outputTokens`, `totalTokens`, `interactions`, `averageTokens`, `medianTokens` |
| `members` | Active member rows, without identifiers |
| `self` | Your member row, including the zero-valued inactive case |
| `cohorts` | Rows with `label` and `members` (count) |
| `daily` | Rows with `day`, `inputTokens`, `outputTokens`, `totalTokens`, `interactions`, `ownTokens`, `activeUsers` |
| `quartiles` | Interpolated token thresholds `q1`, `q2`, `q3` |

Each `members`/`self` row contains only `isSelf`, `inputTokens`, `outputTokens`,
`totalTokens`, `interactions`, `daysActive`, `tokensPerActiveDay`, `sharePercent`,
`rank`, `percentile` and `cohort`. `daily.activeUsers` is that date's active
uploader count; `daily.ownTokens` belongs only to the authenticated viewer.
There are no stable member aliases or peer-specific daily rows.

## Rate limits

| Scope | Limit |
|---|---|
| Per IP (all requests) | 200 requests / minute |
| Per user (uploads) | 100 upload requests / hour |

## Extending this server

This server is also published as a library so you can build a customised server on top of
it without forking. Import `createApp` and `startServer`, mount your own routes and
register your own tables:

```ts
import {
	createApp,
	startServer,
	registerSchemaExtension,
	requireBearerAuth,
	renderNavExtra,
	getDb,
} from '@rajbos/ai-engineering-fluency-sharing-server';
import { Hono } from 'hono';

// Runs before the first getDb(), so the table exists at startup.
registerSchemaExtension('my-metrics', (db) => {
	db.exec(`CREATE TABLE IF NOT EXISTS my_metrics (
		id           INTEGER PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users(id),
		dataset_id   TEXT NOT NULL DEFAULT 'default',
		day          TEXT NOT NULL,
		workspace_id TEXT NOT NULL,
		machine_id   TEXT NOT NULL,
		metrics_json TEXT NOT NULL,
		UNIQUE(user_id, dataset_id, day, workspace_id, machine_id)
	)`);
});

const routes = new Hono();
routes.post('/upload', requireBearerAuth, async (c) => {
	const user = c.get('user');
	// … store rows for user.id …
	return c.json({ ok: true });
});

// The page the nav link points at. `renderNavExtra` renders the same downstream
// links here, so your page header stays consistent with the built-in ones.
const page = new Hono();
page.get('/mine', (c) =>
	c.html(`<!doctype html><html><body>
		<header>
			<a href="/dashboard">My Dashboard</a>
			<a href="/team">Team Insights</a>
			${renderNavExtra(c, '/mine')}
		</header>
		<main>…</main>
	</body></html>`),
);

const app = createApp({
	healthExtra: () => ({ edition: 'my-company' }),
	navExtra: () => [{ href: '/mine', label: 'My Insights' }],
	extend: (a) => a.route('/api/mine', routes).route('/', page),
});

await startServer(app);
```

### Extension points

| Export | Purpose |
|---|---|
| `createApp({ extend })` | Register routes **before** the built-in ones. Because Hono matches in registration order, this also lets you override a built-in path. |
| `createApp({ healthExtra })` | Merge extra fields into `/health`. |
| `createApp({ navExtra })` | Add links to the built-in page headers, so a page you mount through `extend` is reachable from the UI instead of by URL only. Scoped to that app. Labels are escaped, and an href that is not same-origin once the URL is parsed is dropped. |
| `createApp({ mountApi, mountDashboard })` | Opt out of the built-in route groups. |
| `registerSchemaExtension(name, fn)` | Add tables/indexes/migrations. Call before the first `getDb()`. |
| `requireBearerAuth` | Authenticate with the same GitHub token as `/api/upload`, so your rows share the same `user_id`. |
| `getTeamInsights(viewerId, days)`, `parseTeamDays(raw)` | Reuse the safe Team Insights projection and supported-period parsing. Derive `viewerId` only from server-authenticated identity, never request/query input. |
| `TeamInsights`, `TeamMember`, `UsageCohort` | Public TypeScript types for the identity-free projection. |
| `renderNavExtra(c, currentPath)`, `NavLink` | Render the same downstream links inside your own page header, so navigation stays consistent across built-in and custom pages. |
| `startServer(app, opts)` | Backup/restore, DB init with retry, periodic backup, graceful shutdown. |

### Guidance

- **Preserve the [data separation contract](https://github.com/rajbos/ai-engineering-fluency/blob/main/sharing-server/AGENTS.md).**
  Overrides registered before built-in routes can bypass their protection:
  retain owner/admin authorization and the same allowlisted member projection,
  including caching, charts and exports. Add the contract's HTTP/HTML privacy
  regression tests for custom routes; importing the library alone does not
  enforce these boundaries on your extensions.
- **Add tables, don't widen `usage_uploads`.** Keeping downstream tables separate means
  core migrations and your migrations never conflict.
- **Join on `(user_id, dataset_id, day, workspace_id, machine_id)`** — the natural rollup
  key — and use a `LEFT JOIN`, since upload ordering between clients is not guaranteed.
- **Upsert on that key** so a re-upload of the same day replaces rather than duplicates.
- **Reuse `requireBearerAuth`.** A separate auth scheme would produce a different
  `user_id` and make the two datasets impossible to join.

## Security

- **Bearer token auth** — the extension sends your GitHub OAuth token. The server
  validates it against `GET https://api.github.com/user` and caches the result for
  10 minutes. Bad tokens are cached for 1 minute to prevent API spam.
- **CSRF protection** — the dashboard OAuth flow uses a short-lived state cookie.
- **Signed session cookies** — dashboard sessions use HMAC-SHA256-signed cookies
  storing only `{sub, iat, exp}`. User data is re-read from SQLite on each request.
- **XSS prevention** — all user-supplied strings are HTML-escaped before rendering.
- **No API keys** — authentication is fully managed by GitHub OAuth; there are no
  API keys to issue, rotate, or leak.

## Privacy note

Unlike the Azure Storage backend which supports anonymized and pseudonymous modes,
the sharing server is **identified mode only** — every upload is linked to a GitHub
user ID. Workspace and machine names are included or excluded based on the extension's
`shareWorkspaceMachineNames` setting (off by default).

Identified storage does not grant peers access to those fields. The personal
dashboard, identity-free Team Insights and named admin views have separate
server-enforced access boundaries; see the [data separation contract](AGENTS.md).

## Data schema

```sql
users (
  id, github_id, github_login, github_name, avatar_url,
  created_at, last_seen_at, is_admin
)

usage_uploads (
  id, user_id, dataset_id, day, model,
  workspace_id, workspace_name, machine_id, machine_name, editor,
  input_tokens, output_tokens, interactions, schema_version,
  uploaded_at
)
-- UNIQUE(user_id, dataset_id, day, model, workspace_id, machine_id, editor)
```

## Backup

The entire state is one SQLite file at `/data/sharing.db` (or the path in `DB_PATH`).
Back it up with any tool that can copy files, or use `sqlite3 /data/sharing.db .dump`.

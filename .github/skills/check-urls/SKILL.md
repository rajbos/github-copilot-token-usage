---
name: check-urls
description: Find all hardcoded URLs in TypeScript source files and verify they resolve (return HTTP 2xx/3xx). Use when you want to validate that links in tips, hints, and documentation strings are still live.
---

# Check URLs Skill

This skill scans all TypeScript source files for hardcoded `http://` and `https://` URLs and performs HTTP HEAD requests to verify each one resolves without a 4xx/5xx error.

## When to Use This Skill

Use this skill when you need to:
- Validate links added to fluency hints or tips in `maturityScoring.ts`
- Check that VS Code docs URLs, tech.hub.ms video links, or any other hardcoded URLs are still live
- Audit the codebase after bulk URL changes to catch 404s before a release
- Routinely health-check external references as part of a maintenance pass

## Running the Check

```bash
node .github/skills/check-urls/check-urls.js
```

The script will:
1. Recursively scan every `*.ts` file under `src/`
2. Extract all unique `https?://...` URLs (strips trailing punctuation, skips template literals)
3. Skip, and report, every URL whose host is internal: `localhost` / `*.localhost`, loopback (127/8, `::1`), link-local (169.254/16, `fe80::/10`), private (10/8, 172.16/12, 192.168/16, `fc00::/7`), carrier-grade NAT (100.64/10) or unspecified (0/8, `::`) — including hostnames that resolve via DNS to such an address. The resolved address is checked again when the connection is made, so a changing DNS answer cannot slip through
4. Send an HTTP HEAD request to each remaining URL (with a 10-second timeout)
5. If HEAD returns 403, 405 or 501 — statuses that usually mean the server does not handle HEAD — retry once with GET. Any other error status is reported as-is, without a GET
6. Print ✅ OK, ⚠️ REDIRECT, ⚠️ INSECURE (plain `http:`), ⏭️ SKIPPED or ❌ BROKEN for every URL
7. Exit with code `1` if any URL is broken (4xx/5xx after the rules above, timeout or connection error)

## Interpreting Output

| Symbol | Meaning |
|--------|---------|
| ✅ OK | 2xx response — URL is live |
| ⚠️ REDIRECT | 3xx response — URL redirects; consider updating to the final destination |
| ⚠️ INSECURE | Plain `http:` URL — still checked, but switch it to `https:` where the site supports it |
| ⏭️ SKIPPED | Host is localhost or an internal/private address (directly or after DNS) — never requested |
| ❌ BROKEN | 4xx/5xx or connection failure — URL must be fixed |

## After Finding Broken URLs

1. **404 on tech.hub.ms**: The slug may have changed or the page was removed. Check `https://tech.hub.ms` to find the replacement and update `src/maturityScoring.ts`.
2. **404 on code.visualstudio.com**: The VS Code docs may have been reorganised. Search [VS Code docs](https://code.visualstudio.com/docs) for the relevant topic and update the link.
3. **Timeout**: May be a transient network issue. Re-run the script to confirm before changing anything.
4. After fixing, re-run `node .github/skills/check-urls/check-urls.js` to confirm all URLs resolve.
5. Run `npm --prefix vscode-extension run validate` to confirm type-checking, linting, and the build still pass.

## Files in This Directory

- **SKILL.md** — This file; instructions for the skill
- **check-urls.js** — Node.js script that performs the URL scan and resolution check
- **check-urls.test.js** — Unit tests (`node --test .github/skills/check-urls/check-urls.test.js`); no network access
- **SECURITY.md** — Security model for the script
- **README.md** — Short overview of the skill

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
3. Send an HTTP HEAD request to each URL (with a 10-second timeout)
4. If HEAD returns any 4xx status, automatically retry with GET — some servers (e.g. intent URLs, social sharing endpoints) return 404/405 for HEAD but correctly respond to GET
5. Print a summary showing ✅ OK, ⚠️ REDIRECT, or ❌ BROKEN for every URL
6. Exit with code `1` if any URL returns a 4xx or 5xx status on both HEAD and GET, or times out

## Interpreting Output

| Symbol | Meaning |
|--------|---------|
| ✅ OK | 2xx response — URL is live |
| ⚠️ REDIRECT | 3xx response — URL redirects; consider updating to the final destination |
| ❌ BROKEN | 4xx/5xx or connection failure — URL must be fixed |

## After Finding Broken URLs

1. **404 on tech.hub.ms**: The slug may have changed or the page was removed. Check `https://tech.hub.ms` to find the replacement and update `src/maturityScoring.ts`.
2. **404 on code.visualstudio.com**: The VS Code docs may have been reorganised. Search [VS Code docs](https://code.visualstudio.com/docs) for the relevant topic and update the link.
3. **Timeout**: May be a transient network issue. Re-run the script to confirm before changing anything.
4. After fixing, re-run `node .github/skills/check-urls/check-urls.js` to confirm all URLs resolve.
5. Run `npm run compile` to confirm the TypeScript build still passes.

## Files in This Directory

- **SKILL.md** — This file; instructions for the skill
- **check-urls.js** — Node.js script that performs the URL scan and resolution check
- **README.md** — Short overview of the skill

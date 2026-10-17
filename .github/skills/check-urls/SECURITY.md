# Security model: check-urls

Lightweight model derived from reading `check-urls.js`. Update it in the same PR as any
change that adds or alters a trigger surface (see "Skill security classification" in the
repository `AGENTS.md`).

## What the scripts do and talk to

- `check-urls.js` collects every `.ts` file under the repo-root `src/`, extracts all
  `http(s)://` URLs with a regex (`extractUrls`) and requests each one, sequentially.
- DNS: before any request, every hostname that is not an IP literal is resolved with
  `dns.promises.lookup` (`getResolvedInternalReason`) to decide whether it is internal.
  The connection itself resolves again through `guardedLookup`.
- Network: a `HEAD` request, retried once as `GET` only when `HEAD` returns 403, 405 or
  501 (`HEAD_RETRY_STATUSES`, `checkUrl`), to whatever public host the URL names, over
  `http` or `https`, with a 10 second timeout. The response body is never read and
  redirects are not followed (a 3xx is reported as a warning).
- It prints each URL, its status and the source file(s) to stdout. Exit code 1 if any URL
  is broken.
- `check-urls.test.js` is a unit test. It stubs DNS and HTTP and makes no network calls.

## Credentials used and where they come from

None. The only header sent is `User-Agent: copilot-token-tracker-url-checker/1.0`.
No environment variables are read.

## Untrusted inputs parsed

- The text of `src/**/*.ts`. In a local run this is the operator's own checkout. Nothing
  in the repository's workflows runs this script today; if it were run in CI over a pull
  request, URLs added by a fork would be requested from the runner, limited to public
  addresses by the guard below.
- DNS answers for those hostnames (only the addresses are used, to classify them).
- HTTP status codes and error messages from the contacted hosts (only the status code and
  `err.message` are used).

## What it writes and where

Nothing on disk. Output is stdout only.

## External programs run

None.

## Mitigations in the code

- Only `src/` is scanned and only `.ts` files are read (`SRC_DIR`, `collectTsFiles`).
- Internal hosts are never requested; they are skipped and listed as `SKIPPED`
  (`partitionInternalUrls`): `localhost` and `*.localhost`, loopback (127/8, `::1`),
  link-local (169.254/16, `fe80::/10`), private (10/8, 172.16/12, 192.168/16,
  `fc00::/7`), carrier-grade NAT (100.64/10) and unspecified (0/8, `::`)
  (`BLOCKED_RANGES`, `getInternalHostReason`). IPv4-mapped IPv6 addresses are judged by
  their IPv4 part, and alternate IPv4 notations (`http://2130706433/`, `0x7f.1`) are
  normalised by `new URL()` before the check.
- A hostname whose DNS answer contains any internal address is skipped too.
- `guardedLookup` is passed as the `lookup` of every `http(s).request`, so the address
  actually connected to is checked again. A DNS answer that changes between the
  pre-check and the connection (DNS rebinding) fails with a "blocked … address" error
  instead of reaching the internal host.
- IP literal hosts never go through DNS (Node connects to them directly, without the
  `lookup` hook), so `checkUrlWithMethod` classifies the unbracketed host itself and
  refuses an internal one before any request is created.
- Plain `http:` URLs are still checked but flagged as `INSECURE` and counted in the
  summary.
- `GET` is only sent when `HEAD` returned 403, 405 or 501, so a URL that answers `HEAD`
  with any other error is not fetched with `GET`.
- URLs containing `${` template interpolations are skipped.
- Requests are sequential with a fixed timeout and are abandoned after the status line
  (`req.destroy()`), which bounds time and data pulled per URL.
- Malformed URLs are caught by `new URL()` and reported as broken.

## Known gaps

Recorded, not fixed here.

- Redirects are not followed, so the guard does not need to re-check `Location` targets;
  if redirect following is ever added, each hop must go through the same check.
- The block list covers the ranges above, not every special-purpose range (for example
  198.18/15 benchmarking, 192.0.0/24, 6to4/NAT64 prefixes that embed an internal IPv4
  address). Those are requested like any public address.

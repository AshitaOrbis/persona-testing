# Changelog

## 0.3.0 — 2026-06-11

Security-hardening release following an external adversarial code review.
See `reviews/gptpro-2026-06-11.md` for the full review and SECURITY.md for
the resulting threat model.

### Security

- **Origin-restricted navigation (new security boundary).** Model-requested
  navigation is now enforced in code: only the target URL's origin (plus
  origins explicitly allowed via `--allow-origin` / `allowed_origins`) is
  reachable. `file:`, `data:`, `javascript:`, `ftp:`, and cross-origin URLs
  are refused, and click/redirect-induced cross-origin escapes are detected
  and reverted. Private/localhost origins cannot be added to the allowlist
  (the target itself may be localhost).
- **URL redaction.** Credentials, query strings, and fragments are stripped
  from every URL that reaches the model prompt, tool results, reports, or
  logs. The harness performs the initial navigation programmatically so the
  full URL never enters the prompt.
- **No credential echo.** The `type` tool reports only the character count,
  never the typed text.
- **Run budgets.** Iteration cap clamped to 1–100, wall-clock deadline per
  persona (default 15 min), cumulative input/output token budgets, and
  per-request API timeouts.
- **Tool result size cap.** Every tool result is truncated to 20k characters
  before reaching the model.
- **Prompt hardening.** A non-overridable operating-policy preamble; persona
  free-text fields are wrapped in data delimiters. (Defense-in-depth only —
  the enforced boundaries are in code.)
- **Publish workflow split.** The OIDC-privileged publish job no longer runs
  `npm ci` or build scripts; it publishes a tarball built in an unprivileged
  job. All actions pinned to commit SHAs; npm pinned (no more `npm@latest`).
- **npm package allowlist.** `files` field added so stray local files can't
  be packed.

### Fixed

- `check --min-readiness <non-integer>` previously printed FAIL but exited 0
  (NaN comparison); it now exits 2 with a usage error.
- Readiness scores outside 0–100 (e.g. a prompt-injected "999%") are rejected
  and recorded as parse errors instead of passing the gate.
- "No critical bugs found.", "- None", "None observed." and similar phrasings
  no longer count as critical bugs (previously failed CI falsely).
- Unknown commands and unknown flags now exit 2 instead of silently exiting 0.
- Repeated `--persona` flags now work as documented (previously only the
  first was used); `--output-dir` is now implemented; the README's `--json`
  flag (never implemented — JSON is always written) was removed from docs.
- Reports no longer overwrite on same-day reruns: filenames embed a unique
  run ID, and `run` writes a `run-manifest.json` that `check` consumes so
  stale reports can't affect the gate.
- Persona/config YAML is schema-validated at load with actionable errors
  (previously type-asserted; malformed files crashed mid-run).
- Tool inputs from the model are validated; wait timeouts clamped to 30 s;
  malformed OpenAI tool-call JSON now returns an error to the model instead
  of dispatching an empty input.
- Browser/tool errors are tracked as machine-readable stats; `check` marks
  runs where most tool calls failed as INCONCLUSIVE and fails the gate.
- Browser no longer leaks if context/page creation throws (try/finally now
  wraps immediately after launch); `browser.close()` failures no longer mask
  the original error.
- `init` escapes the persona name (YAML-serialized), so names containing
  `:` or newlines can't inject YAML keys.
- Missing Playwright browser binaries at launch now produce the documented
  `npx playwright install chromium` guidance instead of a raw error.

### Documentation

- New SECURITY.md with an honest threat model: what is enforced in code,
  what is mitigated, and what is inherent to a page-content-driven agent.
- README: "constrains" → "guides", security section, CI security note,
  Playwright install step in Quick Start, accurate flag documentation.
- Accessibility example rewritten to state clearly that it is a heuristic
  first pass, not screen-reader or WCAG-contrast testing.

## 0.2.x

- Initial public releases: persona YAML format, Anthropic/OpenAI providers,
  Playwright bridge, markdown/JSON reports, `check` CI gate.

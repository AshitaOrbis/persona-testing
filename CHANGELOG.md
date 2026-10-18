# Changelog

## 0.4.0 — 2026-10-18

The report checker is rebuilt on a real Markdown parser and is stricter: some
reports that 0.3.0 accepted are now refused. As a minor bump on a 0.x line,
0.4.0 is outside `^0.3.0`, so projects depending on that range keep 0.3.x
until they upgrade explicitly.

### Report checker

- Reports are read from the tokens of markdown-it 15.0.2, a pinned CommonMark
  parser and a new runtime dependency, instead of hand-written line scanners.
- `check` refuses forged and out-of-range reports: readiness must be an
  integer from 0 to 100, `critical_bugs` a boolean and the terminal state
  PASSED, and the stored fields must match a fresh parse of the report.
- A run passes only with at least one successful browser observation, one
  scenario-relevant interaction, no navigation failures and a majority of
  healthy calls. Malformed tool-call JSON from a provider is counted rather
  than dropped.
- The run manifest is mandatory and bound to the run id, the invocation, the
  timestamps and the expected personas; an unlisted or missing report fails.
- A report has exactly one Structured Assessment, judged by what a reader
  sees: a heading in ATX or setext form, decorated with emphasis, code or
  links, or written with character references, look-alike letters or symbols
  (a table generated from Unicode's confusables data), fullwidth forms or
  invisible characters still counts. Only the canonical
  `## Structured Assessment` is read.
- Inside the assessment, a level-three heading other than the five format
  sections (Readiness Score, Criteria Verdicts, Actionable Items, Critical
  Bugs, Summary) is fatal, and so is a section name used as a label anywhere
  but its own heading. Prose that merely begins with a section name is not a
  label.
- Only a recognised negative declaration ("None", "No critical bugs found",
  ...) means no critical bugs; an empty section, or short content such as
  "Crash", no longer does.
- Outside code, raw HTML, unsupported named character references, Unicode
  line and paragraph separators and bidirectional controls are fatal. CR and
  CRLF line endings are read as LF.
- A report whose emphasis nests deeper than 100 levels is refused.
- An action item keeps its explicit classification and priority when its
  description wraps onto a second line.

### Runs

- Output cut off at the provider's output cap is recorded as TRUNCATED
  (`output_truncated`), never COMPLETED, and a cut-off tool call is not run.
- Deadline and token budgets are checked before and after every model
  request and tool call; exhausting one ends the run as BUDGET_EXHAUSTED with
  no further provider call.

### Packaging and documentation

- The npm publish job installs nothing: it publishes the tarball built by the
  unprivileged build job, using the npm bundled with Node 24.14.0, whose
  version it asserts first.
- The plaintext API-key config files the loader reads are gitignored.
- README examples include the prepare step and `--invocation`; SECURITY.md
  describes the redirect policy the code enforces.

## 0.3.0 — 2026-06-11

### Follow-up review fixes

A second, independent adversarial review (blind to the first; archived at
`reviews/fable-followup-2026-06-11.md`) was run against the hardened code.
Its findings, fixed in this release:

- **Default Anthropic model ID was invalid** (`claude-sonnet-4-5-20250514`
  spliced the Sonnet 4.5 name onto the Sonnet 4 date). Default runs would
  404 on the first API call. Now `claude-sonnet-4-6`, verified against
  Anthropic's published model list on 2026-07-26. Note this ID is a pinned
  snapshot despite having no date in it — from the 4.6 generation onward,
  dateless Claude IDs are snapshots rather than evergreen pointers — so the
  default still wants a look when model lines turn over (2026-07-26).
- **Dependency advisories cleared**, production count 2 → 0 (2026-07-26):
  `form-data` CRLF injection (GHSA-hmw2-7cc7-3qxx, high, transitive) and
  `yaml` stack overflow on deeply nested collections (GHSA-48c2-rrv3-qjmp,
  moderate, direct — and persona definitions are user-supplied YAML).
- **Origin is now re-checked before every tool call**, not only after
  click/keypress/navigate — closing the passive-redirect gap (`<meta
  refresh>`, timed `location` change) where read-only tools could observe a
  foreign page.
- If the operator's initial URL redirects (http→https, apex→www), the
  landing origin is added to the allowlist and logged instead of breaking
  the run.
- README redaction claim tightened: URL **paths** are not redacted (avoid
  magic-link / reset-token paths); SECURITY.md states this explicitly.
- More "no bugs" phrasings ("No issues.", "None to report", "No problems
  detected") no longer false-positive the critical-bug gate.

### Initial hardening

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

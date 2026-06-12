# Fable Follow-Up Review — 2026-06-11

Independent adversarial re-review by a fresh Claude (Fable 5) agent, blind to
the earlier GPT Pro review (the reviews/ directory was removed from the
working tree during the review). Archived verbatim below.

---

I have completed a thorough adversarial re-review. Here is my full report.

## Review: `persona-testing` (v0.3.0)

This repo is a hardening release that explicitly responds to a prior external review (`reviews/gptpro-2026-06-11.md`, deleted in the working tree but in git history). I verified the prior P0/P1 fixes are **genuinely implemented in code, not just documented**: origin-restricted navigation (`policy.ts`), programmatic initial navigation so the full URL never enters the prompt, credential-echo suppression in the `type` tool, 20k tool-result cap, run budgets, schema validation, bounded readiness parsing, and run manifests all check out. The 24+14 tests pass. The security posture is real and well above average for this class of tool.

That said, adversarial probing surfaced one P1 and two P2 gaps where the code does not fully back the documentation's claims.

### P1 — Default Anthropic model ID is invalid (correctness; default config is broken out of the box)

`src/loop.ts:110`
```ts
this.model = options.model || "claude-sonnet-4-5-20250514";
```
This ID is malformed: it splices the Sonnet **4.5** name onto the release date of Sonnet **4** (`claude-sonnet-4-20250514`). The real Sonnet 4.5 ID is `claude-sonnet-4-5-20250929` — which the README itself uses at line 258. The repo therefore contradicts itself, and a user who runs with the default provider and no explicit model override will hit an Anthropic `404 model_not_found` on the first API call. The built `dist/loop.js:65` carries the same bug. Fix: change the default to `claude-sonnet-4-5-20250929` (and rebuild `dist`).

### P2 — Read-only tools don't re-enforce origin after a passive/timed cross-origin redirect (gap vs. the headline "navigation restricted to origin" claim)

`enforceOrigin` is invoked only by `navigate`, `click`, `select_option`, and `press_key` (`src/tools.ts:318,326,345,352`). It is **not** invoked by `get_outline`, `screenshot`, `get_url`, `scroll_to_bottom`, `hover`, `type`, or `wait_for_selector`.

SECURITY.md claims escapes via "click, key press, or redirect" are reverted, and the README says navigation is "restricted to the target URL's origin." But a hostile page can trigger a redirect that is *not* tied to a model tool action — a `<meta http-equiv="refresh">` or a `setTimeout(() => location = 'https://attacker…')`. If the agent's next call is a read-only tool, `get_outline`/`screenshot` will run on the attacker origin and feed its DOM into the model context / write a screenshot of it to disk, and `get_url` will return the foreign URL — with no policy block and no revert until the *next* click/keypress/navigate. The active vectors the docs emphasize are genuinely covered; the passive-redirect path is the residual gap. It is mitigated by the documented "trusted sites only" scoping, which is why I rate it P2 rather than P1, but it is a real divergence between the in-code boundary and the advertised one. Cheap fix: call `enforceOrigin` (or at least an origin check) at the top of every tool dispatch, or guard `get_outline`/`screenshot`/`get_url`/`scroll_to_bottom`.

### P2 — URL path is not redacted; path-embedded secrets leak to prompt, reports, and `get_url` (privacy; README oversells redaction)

`redactUrl` (`src/policy.ts:131`) strips userinfo, query, and fragment but **keeps the path**. Verified empirically:
- `https://app.example.com/reset/SECRET-TOKEN-abc123` → unchanged (token preserved)
- `https://app.example.com/login?token=SECRET` → `?[redacted]` (correctly redacted)

SECURITY.md scopes its claim precisely to "credentials, query strings, and fragments," so it is technically accurate. But README line 229 broadly states "Secret-bearing URLs are redacted from prompts and reports," and the redacted path flows into the system prompt (`prompt.ts:45`), the saved reports (`reporter.ts:93`), and every `get_url` result (`tools.ts:289`). Path-embedded tokens (password-reset and magic-link URLs are a common pattern: `/reset/<token>`) therefore reach the external model provider and persist to disk. Either tighten the README wording to match SECURITY.md, or redact path segments that look like high-entropy tokens.

### Nits (not P0/P1)
- `detectCriticalBugs` (`parser.ts:178`) only recognizes "no critical bugs"-style negatives; a benign Critical-Bugs section reading "No issues." normalizes to a 9-char string and is flagged as a critical bug. It fails *safe* (blocks the gate), so this is a false-positive nuisance, not a vulnerability.
- `initialNavigate` (`tools.ts:229`) does not run `enforceOrigin`, so if the operator-supplied target itself redirects cross-origin on load, the agent starts on a non-allowlisted origin. Operator-trusted input, low impact.

### Things I verified as correctly implemented (no issue)
- Origin policy correctly rejects `file:`/`data:`/`javascript:`/`ftp:`/cross-origin and resists scheme-smuggling via `new URL` normalization; `--allow-origin` refuses RFC1918/loopback/link-local/metadata addresses.
- `type` tool reports only character counts; tool results are capped at 20k chars in the dispatch wrapper (covers all tools).
- Readiness scores outside 0–100 are rejected (not clamped), and `check` uses the run manifest + tool-health gating, so stale/inconclusive runs can't silently pass CI.
- The publish workflow cleanly separates an unprivileged build job from the `id-token: write` publish job (which never runs `npm ci` or lifecycle scripts), with all actions SHA-pinned and npm version pinned. `dist/` is git-ignored and not committed; `package.json` `files` allowlist prevents stray-file packing.

Net: the hardening is real and the prior P0/P1 are genuinely closed. The one item I'd fix before relying on it is the **invalid default model ID (P1)** — it breaks the default run path. The two P2s are claim-vs-code gaps worth tightening.

---

## Disposition (by the campaign lead, after the review)

| Finding | Disposition |
|---------|-------------|
| P1 invalid default model ID | FIXED — default changed to `claude-sonnet-4-5-20250929` (src/loop.ts) |
| P2 passive-redirect origin gap | FIXED — origin re-checked before EVERY tool dispatch (src/tools.ts), so read-only tools never observe a foreign page |
| P2 URL path not redacted | MITIGATED+DOCUMENTED — README claim tightened to match SECURITY.md; explicit path caveat added to both. Heuristic path redaction was deliberately not added (would corrupt legitimate route visibility). |
| Nit: "No issues." false positive | FIXED — negative-form regex extended + tests |
| Nit: initialNavigate cross-origin landing | FIXED — landing origin from the operator's trusted redirect chain is added to the allowlist and logged (`allowInitialLanding`) |

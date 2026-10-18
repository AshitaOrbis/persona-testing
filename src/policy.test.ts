/**
 * Navigation policy tests — the tool-enforced security boundary.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { NavigationPolicy, redactUrl } from "./policy.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

console.log("\nNavigation Policy Tests\n");

const policy = new NavigationPolicy("https://app.example.com/dashboard?token=abc");

console.log("Model navigation — allowed:");
test("same-origin absolute URL is allowed", () => {
  const r = policy.checkModelNavigation("https://app.example.com/settings", "https://app.example.com/");
  assert.equal(r.ok, true);
});

test("relative path resolves against current URL and is allowed", () => {
  const r = policy.checkModelNavigation("/scenarios", "https://app.example.com/dashboard");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.url, "https://app.example.com/scenarios");
});

test("relative path without leading slash is allowed", () => {
  const r = policy.checkModelNavigation("reports", "https://app.example.com/app/");
  assert.equal(r.ok, true);
});

console.log("\nModel navigation — blocked:");
test("file: URL is blocked", () => {
  const r = policy.checkModelNavigation("file:///etc/passwd", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("javascript: URL is blocked", () => {
  const r = policy.checkModelNavigation("javascript:alert(1)", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("data: URL is blocked", () => {
  const r = policy.checkModelNavigation("data:text/html,<h1>x</h1>", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("cross-origin https URL is blocked", () => {
  const r = policy.checkModelNavigation("https://attacker.example/leak?d=secret", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("same host different scheme is blocked (origin mismatch)", () => {
  const r = policy.checkModelNavigation("http://app.example.com/", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("same host different port is blocked (origin mismatch)", () => {
  const r = policy.checkModelNavigation("https://app.example.com:8443/", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("localhost is blocked when target is remote", () => {
  const r = policy.checkModelNavigation("http://localhost:3000/admin", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("cloud metadata IP is blocked", () => {
  const r = policy.checkModelNavigation("http://169.254.169.254/latest/meta-data/", "https://app.example.com/");
  assert.equal(r.ok, false);
});

test("subdomain of target is blocked (different origin)", () => {
  const r = policy.checkModelNavigation("https://evil.app.example.com/", "https://app.example.com/");
  assert.equal(r.ok, false);
});

console.log("\nExtra allowed origins:");
test("explicitly allowed extra origin passes", () => {
  const p = new NavigationPolicy("https://app.example.com", ["https://auth.example.com"]);
  const r = p.checkModelNavigation("https://auth.example.com/login", "https://app.example.com/");
  assert.equal(r.ok, true);
});

test("extra origin with private host is refused at construction", () => {
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://169.254.169.254"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://localhost:9200"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://10.0.0.5"]));
});

test("IPv4-mapped loopback IPv6 extra origin is refused", () => {
  assert.throws(() =>
    new NavigationPolicy("https://app.example.com", ["http://[::ffff:127.0.0.1]"]),
  );
});

test("IPv4-mapped metadata IPv6 extra origin is refused", () => {
  assert.throws(() =>
    new NavigationPolicy("https://app.example.com", ["http://[::ffff:169.254.169.254]"]),
  );
});

test("IPv6 unspecified and loopback extra origins are refused", () => {
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[::]"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[::1]"]));
});

test("complete IPv6 link-local range is refused", () => {
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[fe80::1]"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[fe90::1]"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[febf::1]"]));
});

test("IPv6 unique-local extra origin is refused", () => {
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[fc00::1]"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://[fdff::1]"]));
});

test("IPv4 private, loopback, and link-local literals are refused", () => {
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://127.0.0.1"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://10.0.0.1"]));
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["http://169.254.169.254"]));
});

test("non-http extra origin is refused at construction", () => {
  assert.throws(() => new NavigationPolicy("https://app.example.com", ["file:///tmp"]));
});

console.log("\nLocal testing:");
test("localhost target allows same-origin localhost navigation", () => {
  const p = new NavigationPolicy("http://localhost:3000");
  const r = p.checkModelNavigation("http://localhost:3000/dashboard", "http://localhost:3000/");
  assert.equal(r.ok, true);
});

test("localhost target still blocks other local ports", () => {
  const p = new NavigationPolicy("http://localhost:3000");
  const r = p.checkModelNavigation("http://localhost:9200/_cat/indices", "http://localhost:3000/");
  assert.equal(r.ok, false);
});

console.log("\nInitial redirect admission:");
test("same-host default-port HTTP-to-HTTPS transition is canonical", () => {
  const p = new NavigationPolicy("http://app.example.com/start");
  assert.equal(p.isAllowedUrl("https://app.example.com/landing"), true);
  assert.equal(p.allowInitialLanding("https://app.example.com/landing"), null);
});

test("initial landing cannot authorize a foreign or private origin", () => {
  const p = new NavigationPolicy("https://app.example.com/start");
  assert.throws(() => p.allowInitialLanding("https://attacker.example/landing"));
  assert.throws(() => p.allowInitialLanding("http://10.0.0.1/admin"));
  assert.equal(p.isAllowedUrl("https://attacker.example/landing"), false);
  assert.equal(p.isAllowedUrl("http://10.0.0.1/admin"), false);
});

console.log("\nOperator URL validation:");
test("operator file: URL is rejected", () => {
  assert.throws(() => new NavigationPolicy("file:///etc/passwd"));
});

test("operator javascript: URL is rejected", () => {
  assert.throws(() => new NavigationPolicy("javascript:alert(1)"));
});

test("operator garbage URL is rejected", () => {
  assert.throws(() => new NavigationPolicy("not a url"));
});

console.log("\nisAllowedUrl:");
test("allowed and disallowed absolute URLs", () => {
  assert.equal(policy.isAllowedUrl("https://app.example.com/x"), true);
  assert.equal(policy.isAllowedUrl("https://attacker.example/"), false);
  assert.equal(policy.isAllowedUrl("file:///etc/passwd"), false);
  assert.equal(policy.isAllowedUrl("garbage"), false);
});

console.log("\nURL redaction:");
test("strips credentials, query, and hash", () => {
  const r = redactUrl("https://user:pass@example.com/path?token=secret#access_token=x");
  assert.ok(!r.includes("user"));
  assert.ok(!r.includes("pass"));
  assert.ok(!r.includes("secret"));
  assert.ok(!r.includes("access_token"));
  assert.ok(r.includes("example.com/path"));
});

test("leaves clean URLs readable", () => {
  assert.equal(redactUrl("https://app.example.com/dashboard"), "https://app.example.com/dashboard");
});

test("handles unparseable input", () => {
  assert.equal(redactUrl("not a url"), "[unparseable-url]");
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}

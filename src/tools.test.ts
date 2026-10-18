/**
 * Playwright bridge boundary tests. These use an in-memory browser double so
 * redirects, popup timing, and navigation failures are deterministic and do
 * not require network access.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import type { Page } from "playwright";
import { NavigationPolicy } from "./policy.js";
import { PlaywrightBridge } from "./tools.js";

type FrameListener = (frame: FakeFrame) => void;
type PageListener = (page: FakePage) => void;
type RouteHandler = (route: FakeRoute) => Promise<void> | void;

class FakeFrame {
  constructor(readonly owner: FakePage) {}
  page(): FakePage {
    return this.owner;
  }
}

class FakeRequest {
  constructor(
    private readonly target: string,
    private readonly ownerFrame: FakeFrame,
  ) {}
  url(): string {
    return this.target;
  }
  frame(): FakeFrame {
    return this.ownerFrame;
  }
  isNavigationRequest(): boolean {
    return true;
  }
  resourceType(): string {
    return "document";
  }
}

class FakeRoute {
  aborted = false;

  constructor(private readonly req: FakeRequest) {}
  request(): FakeRequest {
    return this.req;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  async continue(): Promise<void> {}
}

class FakeContext {
  private routeHandler: RouteHandler | undefined;
  private readonly pageListeners: PageListener[] = [];
  readonly requestedUrls: string[] = [];
  readonly blockedUrls: string[] = [];
  readonly redirects = new Map<string, string[]>();
  readonly pages: FakePage[] = [];
  nextNavigationError: Error | undefined;

  async route(_pattern: string, handler: RouteHandler): Promise<void> {
    this.routeHandler = handler;
  }

  on(event: string, listener: PageListener): void {
    if (event === "page") this.pageListeners.push(listener);
  }

  private emitPage(page: FakePage): void {
    for (const listener of this.pageListeners) listener(page);
  }

  async authorize(page: FakePage, url: string): Promise<void> {
    const route = new FakeRoute(new FakeRequest(url, page.mainFrame()));
    if (this.routeHandler) await this.routeHandler(route);
    if (route.aborted) {
      this.blockedUrls.push(url);
      throw new Error(`page.goto: net::ERR_FAILED at ${url}`);
    }
    this.requestedUrls.push(url);
  }

  openDelayedPopup(url: string): FakePage {
    const popup = new FakePage(this, "about:blank");
    this.emitPage(popup);
    popup.delayedNavigation = url;
    return popup;
  }
}

class FakePage {
  private currentUrl: string;
  private readonly frame: FakeFrame;
  private readonly frameListeners: FrameListener[] = [];
  closed = false;
  delayedNavigation: string | undefined;
  popupOnClick: string | undefined;
  waitNavigation: string | undefined;
  waitNeverResolvesAfterNavigation = false;

  constructor(
    private readonly browserContext: FakeContext,
    initialUrl: string,
  ) {
    this.currentUrl = initialUrl;
    this.frame = new FakeFrame(this);
    browserContext.pages.push(this);
  }

  context(): FakeContext {
    return this.browserContext;
  }

  mainFrame(): FakeFrame {
    return this.frame;
  }

  on(event: string, listener: FrameListener): void {
    if (event === "framenavigated") this.frameListeners.push(listener);
  }

  url(): string {
    return this.currentUrl;
  }

  private commit(url: string): void {
    this.currentUrl = url;
    for (const listener of this.frameListeners) listener(this.frame);
  }

  async goto(url: string): Promise<null> {
    if (this.closed) throw new Error("Target page has been closed");
    const chain = [url, ...(this.browserContext.redirects.get(url) ?? [])];
    for (const hop of chain) {
      await this.browserContext.authorize(this, hop);
      if (this.browserContext.nextNavigationError) {
        const failure = this.browserContext.nextNavigationError;
        this.browserContext.nextNavigationError = undefined;
        throw failure;
      }
      this.commit(hop);
    }
    return null;
  }

  async waitForTimeout(): Promise<void> {
    if (this.delayedNavigation) {
      const target = this.delayedNavigation;
      this.delayedNavigation = undefined;
      await this.goto(target).catch(() => undefined);
    }
  }

  async click(): Promise<void> {
    if (this.popupOnClick) this.browserContext.openDelayedPopup(this.popupOnClick);
  }

  async waitForSelector(): Promise<object> {
    if (this.waitNavigation) this.commit(this.waitNavigation);
    if (this.waitNeverResolvesAfterNavigation) {
      return await new Promise<object>(() => undefined);
    }
    return {};
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async goBack(): Promise<null> {
    return null;
  }
}

function bridgeFor(page: FakePage, policy: NavigationPolicy): PlaywrightBridge {
  return new PlaywrightBridge(page as unknown as Page, {
    screenshotDir: "/tmp/persona-testing-policy-tests",
    personaSlug: "policy",
    policy,
    runId: "20260823",
  });
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

console.log("\nPlaywright Boundary Tests\n");

await test("302 redirect chain cannot land on or authorize a private origin", async () => {
  const start = "https://app.example.com/start";
  const privateLanding = "http://169.254.169.254/latest/meta-data/";
  const context = new FakeContext();
  const page = new FakePage(context, "about:blank");
  context.redirects.set(start, [privateLanding]);
  const policy = new NavigationPolicy(start);
  const bridge = bridgeFor(page, policy);

  await assert.rejects(() => bridge.initialNavigate(start));
  assert.equal(policy.isAllowedUrl(privateLanding), false);
  assert.equal(context.blockedUrls.includes(privateLanding), true);
  assert.equal(context.requestedUrls.includes(privateLanding), false);
});

await test("delayed popup navigation to a forbidden private origin is refused and closed", async () => {
  const context = new FakeContext();
  const page = new FakePage(context, "https://app.example.com/");
  page.popupOnClick = "http://10.0.0.1/admin";
  const bridge = bridgeFor(page, new NavigationPolicy("https://app.example.com/"));

  const result = await bridge.dispatch("click", { selector: "#open-popup" });
  await page.waitForTimeout();
  const popup = context.pages.at(-1);

  assert.match(result, /Clicked|Policy/);
  assert.ok(popup && popup !== page);
  assert.equal(popup.closed, true);
  assert.equal(context.requestedUrls.includes("http://10.0.0.1/admin"), false);
});

await test("wait_for_selector discards a result when the page navigates after the precheck", async () => {
  const context = new FakeContext();
  const page = new FakePage(context, "https://app.example.com/");
  page.waitNavigation = "https://attacker.example/internal-marker";
  const bridge = bridgeFor(page, new NavigationPolicy("https://app.example.com/"));

  const result = await bridge.dispatch("wait_for_selector", { selector: "#internal-secret" });

  assert.match(result, /Policy|blocked/i);
  assert.doesNotMatch(result, /^Found:/);
});

await test("a committed forbidden navigation releases an in-flight observer immediately", async () => {
  const context = new FakeContext();
  const page = new FakePage(context, "https://app.example.com/");
  page.waitNavigation = "https://attacker.example/internal-marker";
  page.waitNeverResolvesAfterNavigation = true;
  const bridge = bridgeFor(page, new NavigationPolicy("https://app.example.com/"));

  const result = await Promise.race([
    bridge.dispatch("wait_for_selector", { selector: "#never-resolves" }),
    new Promise<string>((resolve) => setTimeout(() => resolve("TEST_TIMEOUT"), 100)),
  ]);

  assert.notEqual(result, "TEST_TIMEOUT");
  assert.match(result, /Policy|blocked/i);
});

await test("initial navigation failure never exposes credentials, query, or fragment in thrown text or logs", async () => {
  const secretUrl = "https://user:pass@app.example.com/reset?token=SECRET#fragmentSECRET";
  const context = new FakeContext();
  const page = new FakePage(context, "about:blank");
  context.nextNavigationError = new Error(`page.goto: timeout while navigating to ${secretUrl}`);
  const bridge = bridgeFor(page, new NavigationPolicy(secretUrl));
  const logLines: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logLines.push(args.map(String).join(" "));

  let thrown = "";
  try {
    await bridge.initialNavigate(secretUrl);
  } catch (error) {
    thrown = (error as Error).message;
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  const exposed = `${thrown}\n${logLines.join("\n")}`;
  assert.ok(thrown.length > 0);
  assert.doesNotMatch(exposed, /SECRET|fragmentSECRET|user|pass/);
  assert.match(thrown, /app\.example\.com\/reset/);
});

await test("model navigation failure returns only a redacted target", async () => {
  const secretUrl = "https://user:pass@app.example.com/reset?token=SECRET#fragmentSECRET";
  const context = new FakeContext();
  const page = new FakePage(context, "https://app.example.com/");
  context.nextNavigationError = new Error(`page.goto: timeout while navigating to ${secretUrl}`);
  const bridge = bridgeFor(page, new NavigationPolicy("https://app.example.com/"));

  const result = await bridge.dispatch("navigate", { url: secretUrl });

  assert.doesNotMatch(result, /SECRET|fragmentSECRET|user|pass/);
  assert.match(result, /app\.example\.com\/reset/);
  assert.match(result, /NAVIGATION_FAILED/);
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}

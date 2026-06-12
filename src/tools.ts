/**
 * Playwright Bridge — browser tool definitions and dispatch.
 *
 * Provides 11 browser tools the AI can call, mirroring the tool surface
 * used by Claude Code's water-director persona agents.
 *
 * Security properties enforced here (not in the prompt):
 *   - Model-requested navigation is restricted to allowed origins (NavigationPolicy).
 *   - Click/keyboard-induced cross-origin escapes are detected and reverted.
 *   - Tool inputs are validated; timeouts are clamped.
 *   - Tool results are size-capped before reaching the model.
 *   - Typed text is never echoed back into the model transcript.
 */

import type { Page } from "playwright";
import type { ToolName, ToolStats } from "./schema.js";
import { NavigationPolicy, redactUrl } from "./policy.js";
import { mkdirSync } from "fs";
import { join } from "path";

/** Maximum characters of any single tool result sent to the model. */
const MAX_TOOL_RESULT_CHARS = 20_000;
/** Maximum selector-wait timeout the model may request. */
const MAX_WAIT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Tool schema definitions (sent to the AI model)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser to a URL on the target application's origin. " +
      "Cross-origin, file:, data:, and javascript: URLs are blocked by policy.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to (same-origin absolute URL or relative path).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "click",
    description:
      "Click an element on the page. Use text=, role=, or CSS selectors. Prefer text= and role= selectors for resilience.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            'Playwright selector, e.g. text="Sign In", role=button[name="Submit"], or #my-id.',
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "type",
    description: "Type text into an input field. Clears existing content first.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Selector for the input." },
        text: { type: "string", description: "Text to type." },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "hover",
    description: "Hover over an element to reveal tooltips or menus.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Selector for the element." },
      },
      required: ["selector"],
    },
  },
  {
    name: "select_option",
    description: "Select an option from a <select> dropdown.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Selector for the <select> element." },
        value: { type: "string", description: "The option value or label to select." },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "press_key",
    description: 'Press a keyboard key, e.g. "Enter", "Tab", "Escape".',
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to press (Playwright key name)." },
      },
      required: ["key"],
    },
  },
  {
    name: "wait_for_selector",
    description: "Wait for an element matching the selector to appear in the DOM.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Selector to wait for." },
        timeout_ms: {
          type: "integer",
          description: "Max wait time in milliseconds (default 15000, max 30000).",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "screenshot",
    description:
      "Take a screenshot of the current page. Returns the file path. Use sparingly — prefer get_outline for page structure.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Short descriptive name for the screenshot, e.g. "dashboard-overview".',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_outline",
    description:
      "Get an accessibility snapshot of the page structure. Shows headings, buttons, links, inputs. Use this to understand what's on the page before interacting.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "scroll_to_bottom",
    description: "Scroll to the bottom of the page to load lazy content.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_url",
    description:
      "Get the current page URL (query string and fragment are redacted).",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Playwright Bridge — dispatches tool calls to real browser actions
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  screenshotDir: string;
  personaSlug: string;
  policy: NavigationPolicy;
  runId: string;
}

export class PlaywrightBridge {
  private page: Page;
  private screenshotDir: string;
  private personaSlug: string;
  private policy: NavigationPolicy;
  private runId: string;
  private screenshotCounter = 0;
  readonly screenshots: string[] = [];

  private totalCalls = 0;
  private errorCount = 0;
  private policyBlockCount = 0;
  private navigationFailures = 0;

  constructor(page: Page, options: BridgeOptions) {
    this.page = page;
    this.screenshotDir = options.screenshotDir;
    this.personaSlug = options.personaSlug;
    this.policy = options.policy;
    this.runId = options.runId;
    mkdirSync(this.screenshotDir, { recursive: true });
  }

  get stats(): ToolStats {
    return {
      total_calls: this.totalCalls,
      errors: this.errorCount,
      policy_blocks: this.policyBlockCount,
      navigation_failures: this.navigationFailures,
    };
  }

  /**
   * Programmatic initial navigation to the operator-supplied URL.
   * Called by the harness before the model loop starts, so the full
   * (possibly secret-bearing) URL never needs to appear in the prompt.
   */
  async initialNavigate(fullUrl: string): Promise<void> {
    try {
      await this.page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.page.waitForTimeout(1000); // let SPA hydrate
    } catch (err) {
      this.navigationFailures++;
      throw err;
    }
    // The operator's URL may legitimately redirect (http→https, apex→www).
    // Trust the operator's redirect chain: widen the allowlist to the
    // landing origin and say so.
    const added = this.policy.allowInitialLanding(this.page.url());
    if (added) {
      console.warn(
        `Note: target URL redirected to ${added}; added it to the allowed origins.`,
      );
    }
  }

  /**
   * Dispatch a tool call to the appropriate Playwright action.
   * Never throws — returns error strings so the AI can adapt.
   */
  async dispatch(name: ToolName, input: Record<string, unknown>): Promise<string> {
    this.totalCalls++;
    let result: string;
    try {
      // The page can leave the allowed origins WITHOUT a tool action — e.g.
      // a <meta refresh> or a timed window.location redirect planted by the
      // tested page. Re-check before every tool call so read-only tools
      // (get_outline, screenshot, get_url, ...) never observe a foreign page.
      const drift = await this.enforceOrigin("page (background redirect)");
      if (drift) {
        result = drift;
      } else {
        result = await this.dispatchInner(name, input);
      }
    } catch (err) {
      this.errorCount++;
      if (name === "navigate") this.navigationFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      result = `Error (${name}): ${msg}`;
    }
    return truncateResult(result);
  }

  private async dispatchInner(name: ToolName, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "navigate":
        return await this.navigate(this.requireString(input, "url", name));
      case "click":
        return await this.click(this.requireString(input, "selector", name));
      case "type":
        return await this.typeText(
          this.requireString(input, "selector", name),
          this.requireString(input, "text", name),
        );
      case "hover":
        return await this.hover(this.requireString(input, "selector", name));
      case "select_option":
        return await this.selectOption(
          this.requireString(input, "selector", name),
          this.requireString(input, "value", name),
        );
      case "press_key":
        return await this.pressKey(this.requireString(input, "key", name));
      case "wait_for_selector":
        return await this.waitForSelector(
          this.requireString(input, "selector", name),
          clampTimeout(input.timeout_ms),
        );
      case "screenshot":
        return await this.takeScreenshot(this.requireString(input, "name", name));
      case "get_outline":
        return await this.getOutline();
      case "scroll_to_bottom":
        return await this.scrollToBottom();
      case "get_url":
        return redactUrl(this.page.url());
      default:
        this.errorCount++;
        return `Unknown tool: ${name}`;
    }
  }

  /** Validate a required string input; throws a structured error otherwise. */
  private requireString(input: Record<string, unknown>, key: string, tool: string): string {
    const v = input[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(
        `invalid input for ${tool}: "${key}" is required and must be a non-empty string`,
      );
    }
    return v;
  }

  // -- Individual tool implementations --

  private async navigate(url: string): Promise<string> {
    const check = this.policy.checkModelNavigation(url, this.page.url());
    if (!check.ok) {
      this.policyBlockCount++;
      return `Navigation blocked by policy: ${check.reason}`;
    }
    await this.page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForTimeout(1000); // let SPA hydrate
    // A same-origin URL may redirect cross-origin — detect and revert.
    const escaped = await this.enforceOrigin("navigate (redirect)");
    if (escaped) return escaped;
    return `Navigated to ${redactUrl(this.page.url())}`;
  }

  private async click(selector: string): Promise<string> {
    await this.page.click(selector, { timeout: 10_000 });
    await this.page.waitForTimeout(500);
    const escaped = await this.enforceOrigin("click");
    if (escaped) return escaped;
    return `Clicked: ${selector}`;
  }

  private async typeText(selector: string, text: string): Promise<string> {
    await this.page.fill(selector, text, { timeout: 10_000 });
    // Never echo the typed value back into the model transcript — it may be
    // a credential or PII that would otherwise end up in reports.
    return `Typed ${text.length} characters into ${selector}`;
  }

  private async hover(selector: string): Promise<string> {
    await this.page.hover(selector, { timeout: 10_000 });
    return `Hovered: ${selector}`;
  }

  private async selectOption(selector: string, value: string): Promise<string> {
    await this.page.selectOption(selector, value, { timeout: 10_000 });
    const escaped = await this.enforceOrigin("select_option");
    if (escaped) return escaped;
    return `Selected "${value}" in ${selector}`;
  }

  private async pressKey(key: string): Promise<string> {
    await this.page.keyboard.press(key);
    const escaped = await this.enforceOrigin("press_key");
    if (escaped) return escaped;
    return `Pressed: ${key}`;
  }

  private async waitForSelector(selector: string, timeoutMs?: number): Promise<string> {
    await this.page.waitForSelector(selector, { timeout: timeoutMs ?? 15_000 });
    return `Found: ${selector}`;
  }

  private async takeScreenshot(name: string): Promise<string> {
    this.screenshotCounter++;
    const counter = String(this.screenshotCounter).padStart(3, "0");
    const safeName = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 60);
    const filename = `${this.personaSlug}-${this.runId}-${counter}-${safeName}.png`;
    const filepath = join(this.screenshotDir, filename);

    await this.page.screenshot({ path: filepath, fullPage: false });
    this.screenshots.push(filepath);
    return `Screenshot saved: ${filepath}`;
  }

  private async getOutline(): Promise<string> {
    try {
      // Playwright 1.49+ ariaSnapshot
      const snapshot = await (this.page as any).ariaSnapshot();
      if (snapshot) return snapshot;
    } catch {
      // fallback
    }

    // Fallback: accessibility tree (older Playwright versions)
    try {
      const snapshot = await (this.page as any).accessibility?.snapshot();
      if (snapshot) return JSON.stringify(snapshot, null, 2);
    } catch {
      // fallback
    }

    // Last resort: extract headings, links, buttons via JS
    return await this.page.evaluate(() => {
      const items: string[] = [];
      document.querySelectorAll("h1,h2,h3,h4,a,button,[role=button],input,select,textarea").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || tag;
        const text = (el as HTMLElement).innerText?.slice(0, 100) || el.getAttribute("aria-label") || "";
        if (text.trim()) items.push(`[${role}] ${text.trim()}`);
      });
      return items.join("\n") || "(empty page)";
    });
  }

  private async scrollToBottom(): Promise<string> {
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this.page.waitForTimeout(500);
    return "Scrolled to bottom";
  }

  /**
   * If an action caused the page to leave the allowed origins (link click,
   * form submit, redirect), navigate back and report the policy violation.
   * Returns a message string when an escape was reverted, null otherwise.
   */
  private async enforceOrigin(action: string): Promise<string | null> {
    const current = this.page.url();
    if (current === "about:blank" || this.policy.isAllowedUrl(current)) return null;

    this.policyBlockCount++;
    const offending = redactUrl(current);
    try {
      await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      if (!this.policy.isAllowedUrl(this.page.url())) {
        await this.page.goto(this.policy.initialUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
    } catch {
      try {
        await this.page.goto(this.policy.initialUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } catch {
        this.navigationFailures++;
      }
    }
    return (
      `Policy: the page moved to ${offending} (via ${action}), which is ` +
      `outside the allowed origins. The browser was returned to the target ` +
      `application. Do not attempt to leave the target site.`
    );
  }
}

function clampTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.floor(n), 0), MAX_WAIT_TIMEOUT_MS);
}

function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return (
    result.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[tool result truncated from ${result.length} to ${MAX_TOOL_RESULT_CHARS} characters]`
  );
}

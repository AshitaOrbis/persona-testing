/**
 * Playwright Bridge — browser tool definitions and dispatch.
 *
 * Provides 11 browser tools the AI can call, mirroring the tool surface
 * used by Claude Code's water-director persona agents.
 */

import type { Page } from "playwright";
import type { ToolName } from "./schema.js";
import { mkdirSync } from "fs";
import { join } from "path";

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
    description: "Navigate the browser to a URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to." },
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
          type: "string",
          description: "Max wait time in milliseconds (default 15000).",
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
    description: "Get the current page URL.",
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
}

export class PlaywrightBridge {
  private page: Page;
  private screenshotDir: string;
  private personaSlug: string;
  private screenshotCounter = 0;
  readonly screenshots: string[] = [];

  constructor(page: Page, options: BridgeOptions) {
    this.page = page;
    this.screenshotDir = options.screenshotDir;
    this.personaSlug = options.personaSlug;
    mkdirSync(this.screenshotDir, { recursive: true });
  }

  /**
   * Dispatch a tool call to the appropriate Playwright action.
   * Never throws — returns error strings so the AI can adapt.
   */
  async dispatch(name: ToolName, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "navigate":
          return await this.navigate(input.url as string);
        case "click":
          return await this.click(input.selector as string);
        case "type":
          return await this.typeText(input.selector as string, input.text as string);
        case "hover":
          return await this.hover(input.selector as string);
        case "select_option":
          return await this.selectOption(input.selector as string, input.value as string);
        case "press_key":
          return await this.pressKey(input.key as string);
        case "wait_for_selector":
          return await this.waitForSelector(
            input.selector as string,
            input.timeout_ms ? parseInt(input.timeout_ms as string) : undefined,
          );
        case "screenshot":
          return await this.takeScreenshot(input.name as string);
        case "get_outline":
          return await this.getOutline();
        case "scroll_to_bottom":
          return await this.scrollToBottom();
        case "get_url":
          return this.page.url();
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error (${name}): ${msg}`;
    }
  }

  // -- Individual tool implementations --

  private async navigate(url: string): Promise<string> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForTimeout(1000); // let SPA hydrate
    return `Navigated to ${this.page.url()}`;
  }

  private async click(selector: string): Promise<string> {
    await this.page.click(selector, { timeout: 10_000 });
    await this.page.waitForTimeout(500);
    return `Clicked: ${selector}`;
  }

  private async typeText(selector: string, text: string): Promise<string> {
    await this.page.fill(selector, text, { timeout: 10_000 });
    return `Typed "${text}" into ${selector}`;
  }

  private async hover(selector: string): Promise<string> {
    await this.page.hover(selector, { timeout: 10_000 });
    return `Hovered: ${selector}`;
  }

  private async selectOption(selector: string, value: string): Promise<string> {
    await this.page.selectOption(selector, value, { timeout: 10_000 });
    return `Selected "${value}" in ${selector}`;
  }

  private async pressKey(key: string): Promise<string> {
    await this.page.keyboard.press(key);
    return `Pressed: ${key}`;
  }

  private async waitForSelector(selector: string, timeoutMs?: number): Promise<string> {
    await this.page.waitForSelector(selector, { timeout: timeoutMs ?? 15_000 });
    return `Found: ${selector}`;
  }

  private async takeScreenshot(name: string): Promise<string> {
    this.screenshotCounter++;
    const counter = String(this.screenshotCounter).padStart(3, "0");
    const safeName = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const filename = `${this.personaSlug}-${counter}-${safeName}.png`;
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
}

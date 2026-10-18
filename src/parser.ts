/**
 * Report structure comes from one CommonMark parser with GFM tables,
 * strikethrough and autolink literals. Inline code is displayed text; code
 * blocks cannot define labels. Unsupported rendered constructs fail closed.
 */
import MarkdownIt, { type Token as MarkdownToken } from "markdown-it";
import type {
  ProbeResult, CriteriaVerdict, ActionableItem, Verdict, Classification,
} from "./schema.js";

// Resolved emphasis is installed by Markdown-it postprocessing, independently
// of tokenizer state.level / maxNesting. Keep replay depth explicitly bounded.
const RESOLVED_EMPHASIS_DEPTH_LIMIT = 100;
let replayWorkObserverForTests: ((units: number) => void) | undefined;
/** Test-only observation of actual replay state updates; unset in production. */
export function setReplayWorkObserverForTests(observer?: (units: number) => void): void {
  replayWorkObserverForTests = observer;
}

const markdownParser = new MarkdownIt({ html: true, typographer: false, linkify: true, maxNesting: 100 });
// Preserve entity/escape token provenance for the unsupported-reference policy.
// Neither token contents nor Markdown recognition rules are changed.
markdownParser.core.ruler.disable("text_join");
// The pinned block tokenizer discards remaining input at maxNesting. Its
// inline lookahead also skips remaining input there. Observe parser state at
// those entry points; never infer nesting from Markdown source characters.
const blockTokenize = markdownParser.block.tokenize.bind(markdownParser.block);
markdownParser.block.tokenize = (state, start, end) => {
  if (state.level >= state.md.options.maxNesting && start < end) {
    state.env.personaTestingNestingLimit = true;
  }
  blockTokenize(state, start, end);
};
const inlineTokenize = markdownParser.inline.tokenize.bind(markdownParser.inline);
markdownParser.inline.tokenize = (state) => {
  if (state.level >= state.md.options.maxNesting && state.pos < state.posMax) {
    state.env.personaTestingNestingLimit = true;
  }
  inlineTokenize(state);
};
const inlineSkipToken = markdownParser.inline.skipToken.bind(markdownParser.inline);
markdownParser.inline.skipToken = (state) => {
  if (state.level >= state.md.options.maxNesting && state.pos < state.posMax) {
    state.env.personaTestingNestingLimit = true;
  }
  inlineSkipToken(state);
};


interface Block {
  index: number;
  level: number;
  quotes: number;
  containers: number;
  markup: string;
  text: string;
  source: string;
  references: boolean;
  inline: RenderedInline;
  tokens: MarkdownToken[];
  kind: string;
  row?: number;
  item?: number;
}
interface Document {
  blocks: Block[];
  errors: string[];
}

export function parseAssessment(markdown: string, persona: string, url: string): ProbeResult {
  const result: ProbeResult = {
    persona, timestamp: new Date().toISOString(), url, readiness_pct: 0,
    critical_bugs: false, criteria: {}, items: [], screenshots: [],
    report_markdown: markdown, parse_errors: [],
  };
  const document = parseDocument(markdown);
  result.parse_errors!.push(...document.errors);
  // Check the WHOLE resolved document before any label query can replay a span,
  // including paragraphs preceding the over-deep one and HTML diagnostics.
  const depth = document.blocks.reduce((maximum, block) => Math.max(maximum, block.inline.emphasisDepth), 0);
  if (depth > RESOLVED_EMPHASIS_DEPTH_LIMIT) {
    result.parse_errors!.push(`Report resolved emphasis depth ${depth} exceeds limit ${RESOLVED_EMPHASIS_DEPTH_LIMIT}; report refused before label replay`);
    return result;
  }
  const markers = document.blocks.flatMap((block) => block.quotes === 0
    ? matchingLabels(block.inline, block.inline.starts, ASSESSMENT_NAME, true).flatMap((match) => match ? [block] : [])
    : []);

  if (markers.length !== 1) {
    result.parse_errors!.push(
      `Expected exactly one real terminal ## Structured Assessment block; found ${markers.length}`,
    );
    result.critical_bugs = /CRITICAL\s*BUG:/i.test(renderedBlocks(document.blocks));
    return result;
  }
  const selected = markers[0];
  if (selected.level !== 2 || selected.markup !== "##" || selected.containers !== 0 ||
      headingText(selected.text) !== "structured assessment" ||
      document.blocks.some((b) => b.index > selected.index && b.quotes === 0 && b.level > 0 && b.level <= 2)) {
    result.parse_errors!.push("No real terminal ## Structured Assessment block found; treated as readiness 0");
    result.critical_bugs = /CRITICAL\s*BUG:/i.test(renderedBlocks(document.blocks));
    return result;
  }
  const assessment = document.blocks.filter((b) => b.index > selected.index);
  let structurallyComplete = document.errors.length === 0;

  // The sections counted here are the sections read below: one heading
  // grammar, keyed by VISIBLE heading text, so a heading the count accepts
  // cannot be missed by extraction and a decorated duplicate is a duplicate.
  const sections = levelThreeSections(assessment);

  // --- Readiness Score ---
  // Out-of-range scores are rejected (not clamped) so a prompt-injected
  // "Readiness Score: 999%" cannot pass a CI gate. Every level-three heading
  // whose visible text starts "Readiness Score" counts toward "exactly one".
  const readinessHeadings = [...sections.keys()].flatMap((name) =>
    /^readiness score\b/.test(name) ? sections.get(name)!.map(() => name) : [],
  );
  const readinessMatch =
    readinessHeadings.length === 1
      ? readinessHeadings[0].match(/^readiness score ?: ?(\d+) ?%$/)
      : null;
  if (!readinessMatch) {
    structurallyComplete = false;
    result.parse_errors!.push(
      `Terminal Structured Assessment must contain exactly one readiness score; found ${readinessHeadings.length}` +
        (readinessHeadings.length === 1 ? ` ("${readinessHeadings[0]}" is not "Readiness Score: N%")` : ""),
    );
  } else {
    const n = Number(readinessMatch[1]);
    if (Number.isInteger(n) && n >= 0 && n <= 100) {
      result.readiness_pct = n;
    } else {
      result.readiness_pct = 0;
      result.parse_errors!.push(
        `Invalid readiness score "${readinessMatch[1]}%" (must be 0-100); treated as 0`,
      );
    }
  }
  const REQUIRED_SECTIONS = ["Criteria Verdicts", "Actionable Items", "Critical Bugs", "Summary"];
  for (const sectionName of REQUIRED_SECTIONS) {
    const count = sections.get(sectionName.toLowerCase())?.length ?? 0;
    if (count !== 1) {
      structurallyComplete = false;
      result.parse_errors!.push(
        `Terminal Structured Assessment must contain exactly one ${sectionName} section; found ${count}`,
      );
    }
  }

  // Normalisation covers the markup a model plausibly writes; it cannot
  // enumerate every rendering trick (an entity, a zero-width character, a
  // look-alike letter) that makes a heading LOOK like "Critical Bugs". So a
  // level-three heading that is not one of the format's five sections is fatal
  // rather than ignored. Deeper headings stay inside their section.
  const known = new Set(REQUIRED_SECTIONS.map((name) => name.toLowerCase()));
  for (const name of sections.keys()) {
    if (known.has(name) || /^readiness score\b/.test(name)) continue;
    structurallyComplete = false;
    result.parse_errors!.push(
      `Terminal Structured Assessment contains a section the format does not define: ${JSON.stringify(name.slice(0, 80))}`,
    );
  }

  for (const block of assessment) {
    if (block.level === 3 && block.quotes === 0 && block.references) {
      structurallyComplete = false;
      result.parse_errors!.push(
        `Terminal Structured Assessment contains a section the format does not define: ${JSON.stringify(block.source)}`,
      );
    }
  }

  // A format section's name at the start of anything but its own level-three
  // heading (a "#### Critical Bugs" under Summary, a "**Critical Bugs:** ..."
  // line, a list item, a table cell, an emphasized span) is outside every
  // section read above, so it is fatal; its content is still read for bugs,
  // because detection may only err toward a bug. Before the assessment, a
  // Critical Bugs label is equally fatal: a reader would take it for the
  // report's bug statement. Inside the assessment a blockquote is still
  // something a reader sees there, so its lines, unquoted, are searched too.
  const misplaced = [
    ...misplacedFormatNames(document.blocks.filter((b) => b.index < selected.index && b.quotes === 0), ["criticalbug"], 0),
    ...misplacedFormatNames(assessment, FORMAT_NAMES, 3),
  ];
  for (const m of misplaced) {
    structurallyComplete = false;
    result.parse_errors!.push(
      `Terminal Structured Assessment names a format section outside its own heading: ${JSON.stringify(m.raw.trim().slice(0, 80))}`,
    );
  }

  // --- Criteria Verdicts ---
  result.criteria = parseCriteriaTable(sectionBlocks(assessment, "criteria verdicts"));

  // --- Actionable Items ---
  result.items = parseActionableItems(sectionBlocks(assessment, "actionable items"));

  // --- Critical Bugs ---
  // Detection also reads near-miss headings ("Critical Bug", "Critical Bugs:"),
  // which the count above already makes fatal: it may only err toward a bug.
  const bugSections = [...sections]
    .filter(([name]) => /^critical\s*bugs?\b/.test(name))
    .flatMap(([, content]) => content)
    .concat(misplaced.filter((m) => m.bug).map((m) => m.content));
  result.critical_bugs = detectCriticalBugs(renderedBlocks(assessment), bugSections);

  if (!structurallyComplete) {
    result.readiness_pct = 0;
  }

  return result;
}

const NAMED_REFERENCES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u{a0}", ensp: "\u{2002}", emsp: "\u{2003}",
  thinsp: "\u{2009}", ndash: "\u{2013}", mdash: "\u{2014}", hellip: "\u{2026}", lsquo: "\u{2018}",
  rsquo: "\u{2019}", ldquo: "\u{201c}", rdquo: "\u{201d}", laquo: "\u{ab}", raquo: "\u{bb}", bull: "\u{2022}",
  middot: "\u{b7}", times: "\u{d7}", divide: "\u{f7}", plusmn: "\u{b1}", deg: "\u{b0}", copy: "\u{a9}",
  reg: "\u{ae}", trade: "\u{2122}", larr: "\u{2190}", rarr: "\u{2192}", uarr: "\u{2191}", darr: "\u{2193}",
  harr: "\u{2194}", check: "\u{2713}", cross: "\u{2717}",
};


interface LabelStart {
  start: number;
  close: number;
  raw: number;
}
interface RenderedInline {
  emphasisDepth: number;
  text: string;
  letters: Token[];
  breaks: Set<number>;
  nextBreak: Int32Array;
  starts: LabelStart[];
  spans: LabelStart[];
}

/** Inline text as displayed, with entity decoding already done by the parser. */
function inlinePiece(t: MarkdownToken): string {
  if (t.type === "softbreak" || t.type === "hardbreak") return "\n";
  if (t.type === "html_inline" || t.nesting !== 0) return "";
  if (t.type === "image") return (t.children ?? []).map(inlinePiece).join("");
  return t.content;
}

/** Count resolved em/strong opens and closes, never token.level or source
 * delimiters. Child token arrays (e.g. image alt text) inherit enclosing depth.
 */
function resolvedEmphasisDepth(tokens: MarkdownToken[], enclosing = 0): number {
  let depth = enclosing;
  let maximum = depth;
  for (const token of tokens) {
    if (token.type === "em_open" || token.type === "strong_open") depth++;
    maximum = Math.max(maximum, depth);
    if (token.children) maximum = Math.max(maximum, resolvedEmphasisDepth(token.children, depth));
    if (token.type === "em_close" || token.type === "strong_close") depth--;
  }
  return maximum;
}

/** Render each inline run once. Starts and closes are offsets into one shared
 * letter-token array, never strings containing the remaining paragraph.
 * Normalize displayed pieces with the existing letter grammar; a style start
 * cannot pull a preceding combining mark into its own candidate.
 */
function renderInline(tokens: MarkdownToken[]): RenderedInline {
  const parts: string[] = [];
  const letters: Token[] = [];
  const breaks = new Set<number>();
  const starts: LabelStart[] = [{ start: 0, close: 0, raw: 0 }];
  const active: LabelStart[] = [];
  const spans: LabelStart[] = [];
  let raw = 0;
  for (const t of tokens) {
    if (t.type === "strong_open" || t.type === "em_open") {
      active.push({ start: letters.length, close: letters.length, raw });
    }
    if (t.type === "strong_close" || t.type === "em_close") {
      const span = active.pop();
      if (span) spans.push({ ...span, close: letters.length });
    }
    if (t.type === "hardbreak") breaks.add(letters.length);
    const piece = inlinePiece(t);
    parts.push(piece);
    for (const letter of letterTokens(piece)) letters.push(letter);
    raw += piece.length;
    if (t.type === "hardbreak") starts.push({ start: letters.length, close: letters.length, raw });
  }
  const nextBreak = new Int32Array(letters.length + 1);
  let next = letters.length;
  for (let i = letters.length; i >= 0; i--) {
    if (breaks.has(i)) next = i;
    nextBreak[i] = next;
  }
  return { emphasisDepth: resolvedEmphasisDepth(tokens), text: parts.join(""), letters, breaks, nextBreak, starts, spans };
}

function parseDocument(markdown: string): Document {
  const env = { personaTestingNestingLimit: false };
  const tokens = markdownParser.parse(markdown, env);
  const blocks: Block[] = [];
  const errors = new Set<string>();
  const references = new Set<string>();
  let quotes = 0;
  let row = -1;
  const items: (number | undefined)[] = [];
  const lists: string[] = [];
  const containers: string[] = [];
  const checkControls = (text: string) => {
    if (/[\u{2028}\u{2029}\u{85}\u{b}\u{c}]/u.test(text)) {
      errors.add("Report contains a Unicode line separator, paragraph separator or page break, which the format does not use");
    }
    const bidi = text.match(/[\u{202a}-\u{202e}\u{2066}-\u{2069}]/u);
    if (bidi) errors.add(`Report contains a bidirectional control character (U+${bidi[0].codePointAt(0)!.toString(16).toUpperCase()}) that can reorder what a reader sees`);
  };
  const checkInline = (children: MarkdownToken[]) => {
    let auto = 0;
    for (const child of children) {
      if (child.type === "link_open" && child.info === "auto") auto++;
      if (child.type === "link_close" && child.info === "auto") auto--;
      if (child.type === "html_inline") errors.add("Report contains raw HTML; the format is Markdown only (put markup in a code span)");
      if (child.type === "text_special" && child.info === "entity") {
        const named = /^&([A-Za-z][A-Za-z0-9]*);$/.exec(child.markup);
        if (named && !Object.hasOwn(NAMED_REFERENCES, named[1])) references.add(child.markup);
      }
      // Unknown references remain ordinary text. Escapes, decoded entities,
      // code spans and URI autolinks are distinct tokens and stay literal.
      if (child.type === "text" && auto === 0) {
        for (const match of child.content.matchAll(/&([A-Za-z][A-Za-z0-9]{1,31});/g)) {
          if (!Object.hasOwn(NAMED_REFERENCES, match[1])) references.add(match[0]);
        }
      }
      if (child.children) checkInline(child.children);
      if (child.nesting === 0) checkControls(child.content);
    }
  };
  tokens.forEach((token, index) => {
    if (token.type === "tr_open") row = index;
    if (token.type === "ordered_list_open" || token.type === "bullet_list_open") lists.push(token.type);
    // Unordered descendants inherit their owning action. Only an immediately
    // enclosing ordered list creates an action identity.
    if (token.type === "list_item_open") items.push(lists.at(-1) === "ordered_list_open" ? index : items.at(-1));
    if (token.type === "blockquote_open") quotes++;
    if (token.nesting === 1) containers.push(token.type);
    if (token.type === "fence" || token.type === "code_block") {
      checkControls(token.content);
    }
    if (token.type === "html_block") {
      errors.add("Report contains raw HTML; the format is Markdown only (put markup in a code span)");
      // HTML blocks are already fatal. For conservative legacy diagnostics,
      // tokenize their inline contents with the same parser; do not infer an
      // HTML heading level or invent Markdown block boundaries.
      const children = markdownParser.parseInline(token.content, env)[0].children ?? [];
      checkInline(children);
      const inline = renderInline(children);
      blocks.push({ index, level: 0, quotes, containers: containers.length,
        markup: "", text: inline.text, source: token.content,
        references: children.some((t) => t.info === "entity"),
        inline, tokens: children, kind: "html_block" });
    }
    if (token.type === "inline") {
      const parent = tokens[index - 1];
      const children = token.children ?? [];
      checkInline(children);
      const inline = renderInline(children);
      blocks.push({ index, level: parent.type === "heading_open" ? Number(parent.tag.slice(1)) : 0,
        quotes, containers: containers.length - (parent.type === "heading_open" || parent.type === "paragraph_open" ? 1 : 0),
        markup: parent.markup, text: inline.text, source: token.content,
        references: children.some((t) => t.info === "entity"),
        inline, tokens: children, kind: parent.type, row, item: items.at(-1) });
    }
    if (token.type === "list_item_close") items.pop();
    if (token.type === "ordered_list_close" || token.type === "bullet_list_close") lists.pop();
    if (token.nesting === -1) containers.pop();
    if (token.type === "blockquote_close") quotes--;
  });
  if (env.personaTestingNestingLimit) errors.add(`Report reaches the Markdown parser nesting limit (${markdownParser.options.maxNesting}); content may be truncated`);
  if (references.size) errors.add(`Report contains an unsupported character reference: ${[...references].slice(0, 5).join(" ")}`);
  return { blocks, errors: [...errors] };
}

function headingText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
function renderedBlocks(blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}
function sectionBlocks(blocks: Block[], name: string): Block[] {
  const start = blocks.findIndex((b) => b.level === 3 && b.quotes === 0 && headingText(b.text) === name);
  if (start < 0) return [];
  const next = blocks.findIndex((b, i) => i > start && b.quotes === 0 && b.level > 0 && b.level <= 3);
  return blocks.slice(start + 1, next < 0 ? blocks.length : next);
}
function levelThreeSections(blocks: Block[]): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  blocks.forEach((block, i) => {
    if (block.quotes !== 0 || block.level !== 3) return;
    const next = blocks.findIndex((b, j) => j > i && b.quotes === 0 && b.level > 0 && b.level <= 3);
    const content = renderedBlocks(blocks.slice(i + 1, next < 0 ? blocks.length : next));
    const name = headingText(block.text);
    sections.set(name, [...(sections.get(name) ?? []), content]);
  });
  return sections;
}
function misplacedFormatNames(blocks: Block[], names: readonly string[], sectionLevel: number): { raw: string; bug: boolean; content: string }[] {
  return blocks.flatMap((block, i) => {
    if (block.quotes === 0 && block.level > 0 && block.level <= sectionLevel) return [];
    const candidates = [...block.inline.starts, ...block.inline.spans];
    const matches = new Map(names.map((name) => [name, matchingLabels(block.inline, candidates, name)]));
    const first = candidates.findIndex((_, candidate) => [...matches.values()].some((found) => found[candidate]));
    if (first < 0) return [];
    // Only a selected diagnostic is materialized, bounded to the displayed snippet.
    const raw = block.text.slice(candidates[first].raw, candidates[first].raw + 80);
    const bug = matches.get("criticalbug")?.some(Boolean) ?? false;
    const next = blocks.findIndex((b, j) => j > i && b.level > 0);
    return [{ raw, bug, content: renderedBlocks(blocks.slice(i, next < 0 ? blocks.length : next)) }];
  });
}

/** Table cell and row boundaries come only from the GFM table tokens. */
function parseCriteriaTable(blocks: Block[]): CriteriaVerdict {
  const criteria: CriteriaVerdict = {};
  let cells: string[] = [];
  const consume = () => {
    if (cells.length >= 2 && /^(GOOD|FAIR|POOR|NOT_TESTED)$/i.test(cells[1].trim())) {
      const name = cells[0].trim();
      if (name && name !== "Criterion" && !name.startsWith("-")) {
        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        criteria[key] = cells[1].trim().toUpperCase() as Verdict;
      }
    }
    cells = [];
  };
  // A new row's first cell shares the same inline nesting level. Token row
  // identifiers are attached below by parseDocument, rather than pipe scans.
  let row = -1;
  for (const block of blocks) {
    if (block.quotes !== 0 || (block.kind !== "td_open" && block.kind !== "th_open")) continue;
    const blockRow = block.row!;
    if (blockRow !== row) { consume(); row = blockRow; }
    cells.push(block.text);
  }
  consume();
  return criteria;
}

/** Numbered item boundaries come only from ordered-list/list-item tokens. */
function parseActionableItems(blocks: Block[]): ActionableItem[] {
  const groups = new Map<number, string[]>();
  for (const block of blocks) {
    // Quotes remain visible to label inspection, but cannot supply actions
    // or add example text to an unquoted action's description.
    if (block.quotes !== 0 || block.item === undefined) continue;
    groups.set(block.item, [...(groups.get(block.item) ?? []), block.text]);
  }
  const items: ActionableItem[] = [];
  for (const parts of groups.values()) {
    const text = parts.join(" ").trim();
    if (!text || text === "---" || /^none\.?$/i.test(text)) continue;
    // Rendered soft and hard breaks stay in the description; explicit
    // classification and priority apply to the complete ordered item.
    const match = /^\[?(fixable|tradeoff|false_positive)\]?\s*\(?\s*priority:\s*(critical|high|medium|low)\s*\)?\s*(.+)$/is.exec(text);
    items.push(match ? {
      classification: match[1].toLowerCase() as Classification,
      priority: match[2].toLowerCase() as ActionableItem["priority"], description: match[3].trim(),
    } : { classification: guessClassification(text), priority: guessPriority(text), description: text });
  }
  return items;
}
function detectCriticalBugs(text: string, sections: string[]): boolean {
  return /CRITICAL\s*BUG:/i.test(text) || sections.some(sectionReportsBug);
}

/** The format's names, as the letters a reader sees. */
const ASSESSMENT_NAME = "structuredassessment";
const FORMAT_NAMES = [
  ASSESSMENT_NAME,
  "readinessscore",
  "criteriaverdicts",
  "actionableitems",
  "criticalbug",
  "summary",
];

/**
 * Characters that can pass for format-name or closed label-suffix letters, keyed by their
 * possible readings. Generated under Node (Unicode 17.0) from UTS #39
 * confusables.txt 18.0.0 and UnicodeData.txt 17.0.0: EVERY character stable
 * under NFKC then NFD, regardless of general category, whose skeleton through
 * up to three steps of case change and skeleton equals an alphabet letter's
 * skeleton in either case; plus Latin small capitals and stroked/hooked
 * Latin letters as their base letters. Symbols and punctuation are included
 * (e.g. U+2223 and ASCII pipe); mapped nonletters ALSO keep their ordinary
 * separator/gap reading, and unmapped punctuation keeps its ordinary role.
 * Explicit on purpose: unmapped letters do not acquire arbitrary readings.
 */
const LOOK_ALIKE_GROUPS: Record<string, string> = {
  a: "\u{23a}\u{251}\u{391}\u{3b1}\u{410}\u{430}\u{13aa}\u{15c5}\u{1d00}\u{1d8f}\u{237a}\u{2c65}\u{2c6d}\u{a4ee}\u{ab64}\u{ab7a}\u{102a0}\u{16f40}\u{1df5a}\u{1df6a}",
  b: "\u{180}\u{181}\u{182}\u{183}\u{184}\u{185}\u{243}\u{253}\u{299}\u{392}\u{3b2}\u{412}\u{42c}\u{432}\u{44c}\u{7d5}\u{13cf}\u{13f4}\u{13fc}\u{1472}\u{15af}\u{15f7}\u{1c80}\u{1d6c}\u{1d80}\u{2c82}\u{2c83}\u{a4d0}\u{a557}\u{a796}\u{a797}\u{a7b4}\u{a7b5}\u{ab9f}\u{10282}\u{102a1}\u{10301}\u{1031c}\u{16eb6}\u{16ed1}\u{1d207}",
  c: "\u{187}\u{188}\u{23b}\u{23c}\u{255}\u{421}\u{441}\u{1004}\u{105a}\u{13df}\u{1c83}\u{1d04}\u{2ca4}\u{2ca5}\u{a4da}\u{a792}\u{a793}\u{a794}\u{a7c4}\u{abaf}\u{102a2}\u{10302}\u{10415}\u{1043d}\u{1051b}\u{118e9}\u{118f2}\u{1d134}\u{1df1d}\u{1f74c}",
  d: "\u{110}\u{111}\u{18a}\u{18b}\u{18c}\u{221}\u{256}\u{257}\u{500}\u{501}\u{13a0}\u{13e7}\u{146f}\u{15de}\u{15ea}\u{1d05}\u{1d6d}\u{1d81}\u{1d91}\u{a4d2}\u{a4d3}\u{a7c7}\u{a7c8}\u{ab70}\u{abb7}\u{1018b}\u{1df25}",
  e: "\u{246}\u{247}\u{395}\u{3b5}\u{415}\u{435}\u{4bc}\u{4bd}\u{13ac}\u{1d07}\u{1d92}\u{212e}\u{22ff}\u{2c78}\u{2d39}\u{a4f0}\u{a5cb}\u{ab32}\u{ab34}\u{ab7c}\u{10286}\u{118a6}\u{118ae}\u{118c6}\u{118ce}\u{1df81}",
  f: "\u{191}\u{192}\u{284}\u{3dc}\u{3dd}\u{554}\u{584}\u{7d3}\u{15b4}\u{1d6e}\u{1d82}\u{1e9d}\u{20bd}\u{2cc0}\u{2cc1}\u{2ce8}\u{a4dd}\u{a730}\u{a798}\u{a799}\u{ab35}\u{1017e}\u{101a0}\u{10287}\u{102a5}\u{10525}\u{118a2}\u{118c2}\u{1d213}",
  g: "\u{18d}\u{193}\u{1e4}\u{1e5}\u{260}\u{261}\u{262}\u{29b}\u{50c}\u{50d}\u{551}\u{581}\u{13c0}\u{13f3}\u{13fb}\u{1d83}\u{a4d6}\u{a7a0}\u{a7a1}\u{a7ac}\u{ab90}",
  i: "\u{197}\u{268}\u{1d96}\u{1df1a}",
  il: "1ILil\u{7c}\u{a1}\u{131}\u{196}\u{1c0}\u{269}\u{26a}\u{345}\u{399}\u{3b9}\u{406}\u{456}\u{4c0}\u{4cf}\u{552}\u{582}\u{5c0}\u{5d5}\u{5df}\u{627}\u{661}\u{6f1}\u{7ca}\u{964}\u{104a}\u{13a5}\u{13de}\u{14aa}\u{16c1}\u{16d0}\u{21bf}\u{2223}\u{2373}\u{23fd}\u{2502}\u{2503}\u{2c92}\u{2c93}\u{2cd0}\u{2cd1}\u{2d4a}\u{2d4f}\u{a4e1}\u{a4f2}\u{a56f}\u{a646}\u{a647}\u{a780}\u{a781}\u{a7ae}\u{a7fe}\u{a830}\u{a8ce}\u{aa5d}\u{ab75}\u{abae}\u{1028a}\u{10309}\u{10320}\u{1041b}\u{10443}\u{1050e}\u{10526}\u{10926}\u{10c3e}\u{10ca5}\u{10ce5}\u{10cfa}\u{11047}\u{110c0}\u{11141}\u{111c5}\u{113d4}\u{1144b}\u{115c5}\u{11641}\u{118a3}\u{118b2}\u{118c3}\u{118d2}\u{11c41}\u{11dda}\u{11de1}\u{16d63}\u{16eaa}\u{16ec5}\u{16f16}\u{16f28}\u{1d100}\u{1d22a}\u{1d377}\u{1e141}\u{1e8c7}\u{1ed01}",
  l: "\u{141}\u{142}\u{19a}\u{234}\u{23d}\u{26b}\u{26c}\u{26d}\u{29f}\u{1d0c}\u{1d85}\u{2c60}\u{2c61}\u{2c62}\u{a748}\u{a749}\u{a78e}\u{a7ad}\u{ab37}\u{ab38}\u{ab39}\u{1df04}\u{1df11}\u{1df13}\u{1df26}",
  m: "\u{271}\u{39c}\u{3bc}\u{3fa}\u{3fb}\u{41c}\u{43c}\u{560}\u{13b7}\u{15f0}\u{16d6}\u{1d0d}\u{1d6f}\u{1d86}\u{2c6e}\u{2c98}\u{2c99}\u{a4df}\u{ab3a}\u{ab87}\u{102b0}\u{10311}\u{10c21}\u{11700}\u{118e3}",
  n: "\u{19d}\u{19e}\u{220}\u{235}\u{272}\u{273}\u{274}\u{548}\u{54c}\u{578}\u{57c}\u{1260}\u{144e}\u{1d70}\u{1d87}\u{2229}\u{22c2}\u{2c9a}\u{2c9b}\u{a4e0}\u{a4f5}\u{a790}\u{a791}\u{a7a4}\u{a7a5}\u{ab3b}\u{10513}\u{11abe}\u{16ad1}\u{1d245}\u{1df27}",
  nv: "\u{39d}\u{3bd}",
  o: "0\u{d8}\u{f8}\u{19f}\u{39f}\u{3a3}\u{3bf}\u{3c2}\u{3c3}\u{3da}\u{3db}\u{3ec}\u{3ed}\u{41e}\u{43e}\u{555}\u{585}\u{5e1}\u{647}\u{665}\u{6be}\u{6c1}\u{6d5}\u{6f5}\u{7c0}\u{7cb}\u{840}\u{966}\u{9e6}\u{a66}\u{ae6}\u{b20}\u{b66}\u{be6}\u{c02}\u{c66}\u{c82}\u{ce6}\u{d02}\u{d20}\u{d66}\u{d82}\u{e50}\u{ed0}\u{101d}\u{1040}\u{10ff}\u{110b}\u{11bc}\u{12d0}\u{17e0}\u{1a45}\u{1a80}\u{1a90}\u{1bea}\u{1c82}\u{1cbf}\u{1d0f}\u{1d11}\u{2c7a}\u{2c8a}\u{2c8b}\u{2c9e}\u{2c9f}\u{2d54}\u{3007}\u{a4f3}\u{a74a}\u{a74b}\u{a74c}\u{a74d}\u{ab3d}\u{10292}\u{102ab}\u{1030f}\u{10404}\u{1042c}\u{104c2}\u{104ea}\u{10516}\u{1092c}\u{10c17}\u{10d07}\u{11124}\u{11302}\u{114d0}\u{118a8}\u{118b5}\u{118b7}\u{118c8}\u{118d5}\u{118d7}\u{118e0}\u{11de0}\u{16ae9}\u{1df1b}\u{1e140}\u{1e2f0}",
  r: "\u{1a6}\u{24c}\u{24d}\u{27c}\u{27d}\u{27e}\u{280}\u{13a1}\u{13d2}\u{1587}\u{1d26}\u{1d72}\u{1d73}\u{1d89}\u{2c64}\u{a4e3}\u{a7a6}\u{a7a7}\u{ab46}\u{ab47}\u{ab48}\u{ab49}\u{ab71}\u{aba2}\u{104b4}\u{104dc}\u{16a19}\u{16f35}\u{1d216}\u{1df16}\u{1df28}",
  ry: "\u{413}\u{433}\u{13b1}\u{2c84}\u{2c85}\u{ab81}",
  s: "\u{1bc}\u{1bd}\u{23f}\u{282}\u{405}\u{455}\u{54f}\u{57f}\u{d1f}\u{10bd}\u{10fd}\u{13d5}\u{13da}\u{1cbd}\u{1d74}\u{1d8a}\u{2c7e}\u{2d1d}\u{a4e2}\u{a576}\u{a731}\u{a7a8}\u{a7a9}\u{a7c5}\u{a7c9}\u{a7ca}\u{a7cc}\u{a7cd}\u{aba5}\u{abaa}\u{10296}\u{10420}\u{10448}\u{118a1}\u{118c1}\u{16ad6}\u{16f3a}\u{1df1e}\u{1df29}",
  t: "\u{166}\u{167}\u{1ab}\u{1ac}\u{1ad}\u{1ae}\u{236}\u{23e}\u{288}\u{3a4}\u{3c4}\u{422}\u{442}\u{7e0}\u{13a2}\u{1c84}\u{1c85}\u{1d1b}\u{1d75}\u{22a4}\u{27d9}\u{2c66}\u{2ca6}\u{2ca7}\u{3112}\u{4e05}\u{a4d4}\u{a50b}\u{ab72}\u{10297}\u{102b1}\u{10315}\u{16f0a}\u{1d373}\u{1df09}\u{1df2a}\u{1f768}",
  ty: "\u{118bc}\u{118dc}",
  u: "\u{54d}\u{57d}\u{1200}\u{144c}\u{1d1c}\u{1d99}\u{222a}\u{22c3}\u{a4f4}\u{a79e}\u{a79f}\u{a7b8}\u{a7b9}\u{ab4e}\u{ab52}\u{104ce}\u{104f6}\u{118b8}\u{118d8}\u{16f42}",
  uv: "\u{1b2}\u{28b}",
  uy: "\u{3a5}\u{3c5}",
  v: "\u{474}\u{475}\u{5d8}\u{667}\u{6f7}\u{13d9}\u{142f}\u{1d20}\u{2228}\u{22c1}\u{2c71}\u{2c74}\u{2d38}\u{a4e6}\u{a6df}\u{a75e}\u{a75f}\u{aba9}\u{1051d}\u{10c1f}\u{11706}\u{118a0}\u{118c0}\u{16f08}\u{1cefc}\u{1d20d}\u{1e145}",
  vy: "\u{1d8c}",
  y: "\u{194}\u{1b3}\u{1b4}\u{24e}\u{24f}\u{263}\u{28f}\u{393}\u{3b3}\u{423}\u{443}\u{4ae}\u{4af}\u{7cc}\u{10e7}\u{13a9}\u{13bd}\u{14a5}\u{1ca7}\u{1efe}\u{1eff}\u{2ca8}\u{2ca9}\u{311a}\u{4e2b}\u{a4ec}\u{a7e2}\u{ab5a}\u{ab79}\u{ab8d}\u{102b2}\u{1050f}\u{10c20}\u{118a4}\u{118c4}\u{16f07}\u{16f43}",
};
/** Two Latin letters that together render as one name letter ("rn" as "m"). */
const DIGRAPHS: Record<string, string[]> = { m: ["rn"] };

const LOOK_ALIKE = new Map<string, string>();
for (const [letters, chars] of Object.entries(LOOK_ALIKE_GROUPS)) {
  for (const ch of chars) LOOK_ALIKE.set(ch, letters);
}
/** Hangul filler letters render as blank space. */
const BLANK_LETTER = /[\u{115f}\u{1160}\u{3164}\u{ffa0}]/u;
/** Stands for an unknown named reference (already fatal): any letter or none. */
const ANY_LETTER = "\u{e000}";

interface Token {
  /** "letter"; "gap" renders as nothing visible; "mark" is a visible non-letter. */
  kind: "letter" | "gap" | "mark";
  /** Letter readings, even for a gap/mark; empty = none, null = any letter. */
  letters: string | null;
  /** A letter that may also read as nothing ("0", "1", an unknown reference). */
  optional: boolean;
  /** Only an actual rendered colon delimits a label with following content. */
  colon?: boolean;
}

/** Tokenize already rendered text; code spans are literal and never decoded again. */
function letterTokens(raw: string): Token[] {
  const text = raw.normalize("NFKC").normalize("NFD");
  const tokens: Token[] = [];
  for (const ch of text) {
    if (ch === ANY_LETTER) {
      tokens.push({ kind: "letter", letters: null, optional: true });
    } else if (LOOK_ALIKE.has(ch)) {
      // Consult the table first, but retain the BASE category as an
      // alternative: a mapped mark/gap may be skipped OR read as a letter.
      const kind = /\p{L}/u.test(ch) && !BLANK_LETTER.test(ch) ? "letter"
        : /[\s\p{M}\p{Cf}\p{Cc}]/u.test(ch) || BLANK_LETTER.test(ch) ? "gap" : "mark";
      tokens.push({ kind, letters: LOOK_ALIKE.get(ch)!, optional: ch === "0" || ch === "1", colon: ch === ":" });
    } else if (/\p{L}/u.test(ch) && !BLANK_LETTER.test(ch)) {
      const ascii = /^[A-Za-z]$/.test(ch) ? ch.toLowerCase() : "";
      tokens.push({ kind: "letter", letters: ascii, optional: false });
    } else if (/[\s\p{M}\p{Cf}\p{Cc}]/u.test(ch) || BLANK_LETTER.test(ch)) {
      tokens.push({ kind: "gap", letters: "", optional: false });
    } else {
      tokens.push({ kind: "mark", letters: "", optional: false, colon: ch === ":" });
    }
  }
  return tokens;
}

/** Closed continuations of reserved labels, in the same letter grammar.
 * `criticalbug` also reads the plural and round 3's "Critical Bugs Found:".
 * All other names require the delimiter immediately after the name.
 */
const LABEL_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  criticalbug: ["", "s", "found", "sfound"],
};

/** Shared suffix-state tables: [letters already matched][displayed offset].
 * Full continuations and first-hard-break lines are separate alternatives.
 * For fixed format names/suffixes, building both tables is O(paragraph length).
 * A close inside a run selects its first subsequent hard break; only the span
 * prefix before that close needs replay. Prefix lengths sum to at most the
 * explicit resolved-emphasis depth limit times the paragraph length (checked
 * for the whole document before any matchingLabels call). No suffix is
 * copied, tokenized or classified per emphasis span.
 */
function matchingLabels(inline: RenderedInline, starts: LabelStart[], name: string, declaration = false): boolean[] {
  const { letters: tokens, breaks, nextBreak } = inline;
  const count = tokens.length;
  const matches = starts.map(() => false);
  const can = (t: Token | undefined, letter: string) =>
    t !== undefined && (t.letters === null || t.letters.includes(letter));
  // Shared first-letter reachability avoids building word tables when every
  // displayed start is ordinary prose. Gaps/marks retain both readings.
  const possible = new Uint8Array(count + 1);
  for (let i = count - 1; i >= 0; i--) {
    const t = tokens[i];
    possible[i] = Number(can(t, name[0]) ||
      (DIGRAPHS[name[0]] ?? []).some((p) => can(t, p[0]) && can(tokens[i + 1], p[1])) ||
      ((t.kind !== "letter" || t.optional) && possible[i + 1]));
  }
  if (!starts.some((span) => possible[span.start])) return matches;
  const delimiter = (t: Token) => declaration
    ? t.kind !== "letter" || t.optional : t.colon === true;
  for (const suffix of declaration ? [""] : (LABEL_SUFFIXES[name] ?? [""])) {
    const word = name + suffix;
    const full = Array.from({ length: word.length + 1 }, () => new Uint8Array(count + 1));
    const line = Array.from({ length: word.length + 1 }, () => new Uint8Array(count + 1));
    full[word.length][count] = line[word.length][count] = 1;
    for (let i = count - 1; i >= 0; i--) {
      const t = tokens[i];
      full[word.length][i] = Number(t.kind === "gap" ? full[word.length][i + 1] : delimiter(t));
      line[word.length][i] = breaks.has(i) ? 1
        : Number(t.kind === "gap" ? line[word.length][i + 1] : delimiter(t));
      for (let j = word.length - 1; j >= 0; j--) {
        const skip = t.kind !== "letter" || t.optional;
        const read = can(t, word[j]);
        const pair = (DIGRAPHS[word[j]] ?? []).some((p) => can(t, p[0]) && can(tokens[i + 1], p[1]));
        full[j][i] = Number((skip && full[j][i + 1]) || (read && full[j + 1][i + 1]) || (pair && full[j + 1][i + 2]));
        if (!breaks.has(i)) {
          line[j][i] = Number((skip && line[j][i + 1]) || (read && line[j + 1][i + 1]) ||
            (pair && !breaks.has(i + 1) && line[j + 1][i + 2]));
        }
      }
    }
    starts.forEach((span, candidate) => {
      if (matches[candidate] || !possible[span.start]) return;
      if (full[0][span.start]) { matches[candidate] = true; return; }
      if (nextBreak[span.start] >= span.close) {
        matches[candidate] = Boolean(line[0][span.start]);
        return;
      }
      // Earlier breaks INSIDE emphasis are text, not its ending alternative.
      // Seed the prefix replay with shared states at the closing offset.
      let next = Uint8Array.from(line.map((row) => row[span.close]));
      let next2 = Uint8Array.from(line.map((row) => row[span.close + 1] ?? 0));
      for (let i = span.close - 1; i >= span.start; i--) {
        replayWorkObserverForTests?.(word.length + 1);
        const t = tokens[i];
        const current = new Uint8Array(word.length + 1);
        current[word.length] = Number(t.kind === "gap" ? next[word.length] : delimiter(t));
        for (let j = word.length - 1; j >= 0; j--) {
          const pair = (DIGRAPHS[word[j]] ?? []).some((p) => can(t, p[0]) && can(tokens[i + 1], p[1]));
          current[j] = Number(((t.kind !== "letter" || t.optional) && next[j]) ||
            (can(t, word[j]) && next[j + 1]) || (pair && next2[j + 1]));
        }
        next2 = next;
        next = current;
      }
      matches[candidate] = Boolean(next[0]);
    });
  }
  return matches;
}


function sectionReportsBug(content: string): boolean {
  // Normalize common "no bugs" phrasings: strip list markers, emphasis,
  // surrounding whitespace, and trailing punctuation.
  const section = content
    .trim()
    .toLowerCase()
    .replace(/^[-*•\s]+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim();

  // Only a recognised negative declaration means "no critical bugs". Anything
  // else — an empty section, a one-word "Crash", text that merely starts like a
  // negative — counts as a reported bug, so ambiguity fails the gate closed.
  const NEGATIVE_FORMS =
    /^(none|n\/a|nothing( critical)?|none (observed|found|detected|noted|identified|encountered|to report)|no (critical |major |blocking )?(bugs?|issues?|problems?|defects?)( were| was)?( found| observed| detected| noted| identified| encountered)?)$/;
  return !NEGATIVE_FORMS.test(section);
}

// --- Heuristic helpers for fallback parsing ---

function guessClassification(text: string): Classification {
  const lower = text.toLowerCase();
  if (
    lower.includes("css") ||
    lower.includes("label") ||
    lower.includes("navigation") ||
    lower.includes("link") ||
    lower.includes("button") ||
    lower.includes("text") ||
    lower.includes("color") ||
    lower.includes("spacing")
  ) {
    return "fixable";
  }
  if (
    lower.includes("feature") ||
    lower.includes("architecture") ||
    lower.includes("redesign") ||
    lower.includes("model")
  ) {
    return "tradeoff";
  }
  return "fixable";
}

function guessPriority(text: string): ActionableItem["priority"] {
  const lower = text.toLowerCase();
  if (lower.includes("critical") || lower.includes("broken") || lower.includes("crash")) {
    return "critical";
  }
  if (lower.includes("important") || lower.includes("missing") || lower.includes("cannot")) {
    return "high";
  }
  if (lower.includes("minor") || lower.includes("nice to") || lower.includes("could")) {
    return "low";
  }
  return "medium";
}

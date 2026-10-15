// SPDX-License-Identifier: MIT
// .tpy `notes.state` → TipTap JSON pre-pass (architecture §9 + B13).
//
// MUST run BEFORE editor.setContent(json): TipTap's JSON path does not run
// isAllowedUri or mark-attribute validation — mark attrs are applied verbatim,
// so a crafted .tpy note can smuggle a `javascript:` link into the render
// surface (stored XSS). This pass:
//   - strips `link` marks whose href fails the B13 allowlist (text is kept),
//   - maps unknown node types to paragraphs (text always preserved),
//   - strips unknown marks,
//   - counts every fallback into the import report.
// Wrap per-note in try/catch at the call site: one hostile note must not
// throw inside a 50-item import transaction and poison the batch.

export interface SchemaMapResult {
  doc: unknown;
  /** unknown nodes demoted / unknown marks stripped */
  fallbacks: number;
  /** hostile link marks stripped (text preserved) */
  strippedLinks: number;
}

interface TiptapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

interface TiptapMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

const KNOWN_NODES = new Set([
  "doc",
  "paragraph",
  "text",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "horizontalRule",
  "hardBreak",
  "codeBlock",
]);

const KNOWN_MARKS = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "superscript",
  "subscript",
  "link",
]);

function collectText(node: TiptapNode): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) return node.content.map(collectText).join("");
  return "";
}

function mapMark(
  mark: TiptapMark,
  isAllowedUri: (url: string) => boolean,
  counters: { fallbacks: number; strippedLinks: number },
): TiptapMark | null {
  const type = mark?.type;
  if (type === "link") {
    const href = mark?.attrs?.href;
    if (typeof href === "string" && isAllowedUri(href)) {
      // Rebuild attrs — never pass through verbatim (no target/rel smuggling).
      return { type: "link", attrs: { href } };
    }
    counters.strippedLinks += 1;
    return null; // strip the mark, keep the text
  }
  if (type && KNOWN_MARKS.has(type)) {
    return { type };
  }
  counters.fallbacks += 1;
  return null;
}

function mapNode(
  node: TiptapNode,
  isAllowedUri: (url: string) => boolean,
  counters: { fallbacks: number; strippedLinks: number },
): TiptapNode {
  if (!node || typeof node !== "object") {
    counters.fallbacks += 1;
    return { type: "paragraph" };
  }
  const type = node.type;
  if (type === "text") {
    const marks = Array.isArray(node.marks)
      ? node.marks
          .map((m) => mapMark(m, isAllowedUri, counters))
          .filter((m): m is TiptapMark => m !== null)
      : undefined;
    return {
      type: "text",
      text: typeof node.text === "string" ? node.text : "",
      ...(marks && marks.length ? { marks } : {}),
    };
  }
  if (type && KNOWN_NODES.has(type)) {
    const content = Array.isArray(node.content)
      ? node.content.map((c) => mapNode(c, isAllowedUri, counters))
      : undefined;
    // Preserve only safe attrs (heading level); drop everything else.
    const attrs =
      type === "heading" && node.attrs && typeof node.attrs.level === "number"
        ? { level: Math.min(6, Math.max(1, node.attrs.level)) }
        : undefined;
    return { type, ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) };
  }
  // Unknown node → paragraph carrying its text (text always preserved).
  counters.fallbacks += 1;
  const text = collectText(node);
  return text
    ? { type: "paragraph", content: [{ type: "text", text }] }
    : { type: "paragraph" };
}

export function mapTropyNoteState(
  raw: unknown,
  isAllowedUri: (url: string) => boolean,
): SchemaMapResult {
  const counters = { fallbacks: 0, strippedLinks: 0 };
  try {
    const root = raw as TiptapNode;
    if (!root || root.type !== "doc") {
      counters.fallbacks += 1;
      const text =
        typeof raw === "string" ? raw : collectText(root ?? ({} as TiptapNode));
      return {
        doc: {
          type: "doc",
          content: text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [],
        },
        ...counters,
      };
    }
    return { doc: mapNode(root, isAllowedUri, counters), ...counters };
  } catch {
    // One hostile note never throws: degrade to an empty paragraph.
    counters.fallbacks += 1;
    return { doc: { type: "doc", content: [{ type: "paragraph" }] }, ...counters };
  }
}

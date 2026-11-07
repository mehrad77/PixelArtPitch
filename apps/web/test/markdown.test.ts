// The Docs page's Markdown reader (src/lib/markdown.ts): raw HTML stays text, only safe links are links, images are
// their alt text, and the blocks a doc uses (headings, lists, code, tables, quotes) come out as written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type Block,
  type Inline,
  linkKind,
  parseInline,
  parseMarkdown,
  resolveRelative,
  textOf,
} from "../src/lib/markdown.ts";

/** every inline node in a tree */
function inlines(bs: Block[]): Inline[] {
  const out: Inline[] = [];
  const walkI = (xs: Inline[]) => {
    for (const x of xs) {
      out.push(x);
      if ("children" in x) walkI(x.children);
    }
  };
  for (const b of bs) {
    if (b.t === "h" || b.t === "p") walkI(b.children);
    if (b.t === "quote") out.push(...inlines(b.children));
    if (b.t === "list") for (const it of b.items) out.push(...inlines(it));
    if (b.t === "table") for (const c of [...b.head, ...b.rows.flat()]) walkI(c);
  }
  return out;
}
const KINDS = new Set(["text", "code", "em", "strong", "del", "link", "img", "br"]);

test("raw HTML is text: tags, entities and event handlers come through as the characters they are", () => {
  const src = [
    '<script>alert("x")</script>',
    "",
    '<img src=x onerror="alert(1)">',
    "",
    "A <b>bold</b> word &amp; an &lt;entity&gt; and <iframe src='//evil'></iframe>.",
    "",
    "| a | b |",
    "|---|---|",
    "| <svg onload=alert(1)> | `<x>` |",
    "",
    "```html",
    "<div onclick='x()'>hi</div>",
    "```",
  ].join("\n");
  const bs = parseMarkdown(src);
  // no node kind exists that could carry HTML: only text-bearing kinds
  for (const x of inlines(bs)) assert.ok(KINDS.has(x.t), x.t);
  const p = (k: number) => textOf((bs[k] as { children: Inline[] }).children);
  assert.equal(p(0), '<script>alert("x")</script>');
  assert.equal(p(1), '<img src=x onerror="alert(1)">');
  assert.equal(p(2), "A <b>bold</b> word &amp; an &lt;entity&gt; and <iframe src='//evil'></iframe>.");
  const table = bs[3] as Extract<Block, { t: "table" }>;
  assert.equal(textOf(table.rows[0][0]), "<svg onload=alert(1)>");
  assert.deepEqual(table.rows[0][1], [{ t: "code", text: "<x>" }]);
  assert.deepEqual(bs[4], { t: "code", lang: "html", text: "<div onclick='x()'>hi</div>" });
});

test("links: only http(s), mailto, relative paths and #anchors are links", () => {
  for (const h of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:x", "data:text/html,<b>", "vbscript:x"])
    assert.equal(linkKind(h), null, h);
  for (const h of ["file:///etc/passwd", "//evil.example/x", "\\\\evil", "", "ftp://x"])
    assert.equal(linkKind(h), null, h);
  assert.equal(linkKind("https://example.com"), "external");
  assert.equal(linkKind("mailto:a@example.com"), "external");
  assert.equal(linkKind("#routes"), "anchor");
  assert.equal(linkKind("../API.md#routes"), "relative");
  assert.equal(linkKind("docs/roles/writer.md"), "relative");
  // a link's text is parsed, its href kept as written for the renderer to judge
  assert.deepEqual(parseInline("[go](javascript:alert(1))"), [
    { t: "link", href: "javascript:alert(1)", children: [{ t: "text", text: "go" }] },
  ]);
  assert.deepEqual(parseInline("![a <b> pic](x.png)"), [{ t: "img", alt: "a <b> pic" }]);
});

test("relative links resolve against the doc's folder and never climb out of the repo", () => {
  assert.deepEqual(resolveRelative("docs/roles/writer.md", "../WRITING-GUIDE.md"), {
    path: "docs/WRITING-GUIDE.md",
    hash: "",
  });
  assert.deepEqual(resolveRelative("docs/API.md", "roles/writer.md#tools"), {
    path: "docs/roles/writer.md",
    hash: "#tools",
  });
  assert.deepEqual(resolveRelative("README.md", "./docs/API.md"), { path: "docs/API.md", hash: "" });
  assert.deepEqual(resolveRelative("docs/API.md", "#shapes"), { path: "docs/API.md", hash: "#shapes" });
  assert.equal(resolveRelative("docs/API.md", "../../etc/x.md"), null);
});

test("the blocks: headings with ids, nested lists, ordered starts, tables with alignment, quotes, rules", () => {
  const bs = parseMarkdown(
    "# Title\n\n## Title\n\n- a\n- b\n  - b1\n\n3. three\n4. four\n\n| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n\n> said\n\n---\n\nsnake_case_word and *em* and **strong** and ~~gone~~ and `a*b`",
  );
  assert.deepEqual(
    bs.map((b) => b.t),
    ["h", "h", "list", "list", "table", "quote", "hr", "p"],
  );
  assert.equal((bs[0] as any).id, "title");
  assert.equal((bs[1] as any).id, "title-1");
  const ul = bs[2] as Extract<Block, { t: "list" }>;
  assert.equal(ul.items.length, 2);
  assert.equal(ul.items[1][1].t, "list");
  const ol = bs[3] as Extract<Block, { t: "list" }>;
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.deepEqual((bs[4] as any).align, ["left", "center", "right"]);
  const last = (bs[7] as any).children as Inline[];
  assert.deepEqual(
    last.map((x) => x.t),
    ["text", "em", "text", "strong", "text", "del", "text", "code"],
  );
  assert.equal(textOf(last.slice(0, 1)), "snake_case_word and ");
});

test("the repo's own docs parse into blocks under a heading", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  for (const f of ["README.md", "AGENTS.md", "docs/API.md", "docs/PIP-JOURNEY.md", "docs/roles/writer.md"]) {
    const bs = parseMarkdown(readFileSync(root + f, "utf8"));
    assert.ok(bs.length > 3, f);
    assert.equal(bs.find((b) => b.t === "h")?.t, "h", `${f} has a heading`);
  }
});

// A small, safe Markdown reader for the Docs page: Markdown → a plain AST, which components/Markdown.tsx turns into
// React elements (never innerHTML, so every character of the source is text). Headings, paragraphs, lists (nested),
// fenced code, tables, block quotes, rules, links, inline code, emphasis, strikethrough. Raw HTML stays text, images
// become their alt text, and only http(s), mailto, relative and #anchor links are links. Pure: node tests run it.

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "em"; children: Inline[] }
  | { t: "strong"; children: Inline[] }
  | { t: "del"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "img"; alt: string }
  | { t: "br" };

export type Align = "" | "left" | "center" | "right";
export type Block =
  | { t: "h"; level: number; id: string; children: Inline[] }
  | { t: "p"; children: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; children: Block[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/** the words of an inline run, for ids, titles and labels */
export const textOf = (xs: Inline[]): string =>
  xs
    .map((x) =>
      x.t === "text" || x.t === "code" ? x.text : x.t === "img" ? x.alt : x.t === "br" ? " " : textOf(x.children),
    )
    .join("");

/** GitHub-style heading ids: lower case, punctuation off, spaces to dashes; repeats get -1, -2 */
export function slugger() {
  const seen = new Map<string, number>();
  return (s: string) => {
    const base =
      s
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-") || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

// ---------------------------------------------------------------- links

export type LinkKind = "external" | "relative" | "anchor";
/** what a link may be: http(s)/mailto open outside, a relative path or #anchor stays in; anything else (javascript:,
 * data:, vbscript:, file:, protocol-relative //host) is no link at all */
export function linkKind(href: string): LinkKind | null {
  const h = href.trim();
  if (!h) return null;
  if (h.startsWith("#")) return "anchor";
  if (/^(https?:\/\/|mailto:)/i.test(h)) return "external";
  if (h.startsWith("//") || h.startsWith("\\")) return null;
  // any scheme at all (letters then a colon before the first slash, ? or #) is refused
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  return "relative";
}

/** a relative link against the doc it sits in: "docs/roles/writer.md" + "../API.md#routes" → docs/API.md, #routes */
export function resolveRelative(from: string, href: string): { path: string; hash: string } | null {
  const [p, ...h] = href.split("#");
  const hash = h.length ? `#${h.join("#")}` : "";
  const clean = p.split("?")[0];
  if (!clean) return { path: from, hash };
  const base = clean.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!base.length) return null;
      base.pop();
    } else base.push(safeDecode(seg));
  }
  return { path: base.join("/"), hash };
}
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// ---------------------------------------------------------------- inline

const PUNCT = /[\\`*_{}[\]()#+\-.!|<>~"']/;

function findClose(s: string, from: number, delim: string): number {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      i = end < 0 ? i + run.length : end + run.length;
      continue;
    }
    if (s.startsWith(delim, i) && i > from && s[i - 1] !== " ") {
      // `_` closes only at a word's end
      if (delim[0] === "_" && /[\p{L}\p{N}]/u.test(s[i + delim.length] ?? "")) {
        i++;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/** `[text](url "title")` starting at s[i] === "[": the text, the url and where it ends; null when it isn't one */
function bracket(s: string, i: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  let k = j + 2;
  let paren = 1;
  for (; k < s.length; k++) {
    if (s[k] === "(") paren++;
    else if (s[k] === ")" && --paren === 0) break;
  }
  if (k >= s.length) return null;
  let url = s.slice(j + 2, k).trim();
  const titled = /^(\S+)\s+["'(].*["')]$/.exec(url);
  if (titled) url = titled[1];
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
  return { text: s.slice(i + 1, j), url, end: k + 1 };
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "\\" && s[i + 1] === "\n") {
      flush();
      out.push({ t: "br" });
      i += 2;
      continue;
    }
    if (c === "\n") {
      if (buf.endsWith("  ")) {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
      } else buf = `${buf.replace(/ +$/, "")} `;
      i++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let text = s.slice(i + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(text)) text = text.slice(1, -1);
        out.push({ t: "code", text });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const b = bracket(s, i + 1);
      if (b) {
        flush();
        out.push({ t: "img", alt: textOf(parseInline(b.text)) });
        i = b.end;
        continue;
      }
    }
    if (c === "[") {
      const b = bracket(s, i);
      if (b) {
        flush();
        out.push({ t: "link", href: b.url, children: parseInline(b.text) });
        i = b.end;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", href: m[1], children: [{ t: "text", text: m[1].replace(/^mailto:/i, "") }] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "~" && s[i + 1] === "~") {
      const end = findClose(s, i + 2, "~~");
      if (end > i + 2) {
        flush();
        out.push({ t: "del", children: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const intraword = c === "_" && /[\p{L}\p{N}]/u.test(s[i - 1] ?? "");
      const dbl = s[i + 1] === c;
      const d = dbl ? c + c : c;
      if (!intraword && s[i + d.length] && s[i + d.length] !== " ") {
        const end = findClose(s, i + d.length, d);
        if (end > i + d.length) {
          flush();
          const kids = parseInline(s.slice(i + d.length, end));
          out.push(dbl ? { t: "strong", children: kids } : { t: "em", children: kids });
          i = end + d.length;
          continue;
        }
      }
      buf += d;
      i += d.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const cells = (line: string) => {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < l.length; i++) {
    if (l[i] === "\\" && l[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (l[i] === "`") {
      code = !code;
      cur += "`";
    } else if (l[i] === "|" && !code) {
      out.push(cur.trim());
      cur = "";
    } else cur += l[i];
  }
  out.push(cur.trim());
  return out;
};

const startsBlock = (l: string) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || BULLET.test(l) || ORDERED.test(l) || QUOTE.test(l);

export function parseMarkdown(src: string, slug = slugger()): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    // fenced code: everything to the closing fence is text
    const f = FENCE.exec(l);
    if (f) {
      const fence = f[1];
      const indent = /^ */.exec(l)![0].length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      i++;
      out.push({ t: "code", lang: f[2] ?? "", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      const children = parseInline(h[2] ?? "");
      out.push({ t: "h", level: h[1].length, id: slug(textOf(children)), children });
      i++;
      continue;
    }
    if (HR.test(l)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(l)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE.exec(lines[i]);
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ t: "quote", children: parseMarkdown(body.join("\n"), slug) });
      continue;
    }
    const b = BULLET.exec(l) ?? ORDERED.exec(l);
    if (b) {
      const ordered = !BULLET.test(l);
      const items: Block[][] = [];
      const start = ordered ? Number(b[2]) : 1;
      while (i < lines.length) {
        const m = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        // the item's text starts after its marker; lines indented past the marker belong to it
        const pad = m[1].length + m[2].length + 1;
        const body = [m[3]];
        i++;
        while (i < lines.length) {
          const n = lines[i];
          if (!n.trim()) {
            // a blank line goes on only when the next line is still indented under the item
            const next = lines[i + 1] ?? "";
            if (next.trim() && /^ */.exec(next)![0].length >= Math.min(pad, 2)) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          const ind = /^ */.exec(n)![0].length;
          if (ind >= Math.min(pad, 2)) body.push(n.slice(Math.min(ind, pad)));
          else if (!startsBlock(n) && !TABLE_SEP.test(lines[i + 1] ?? "")) body.push(n.trim());
          else break;
          i++;
        }
        items.push(parseMarkdown(body.join("\n"), slug));
        while (i < lines.length && !lines[i].trim() && (ordered ? ORDERED : BULLET).test(lines[i + 1] ?? "")) i++;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }
    // a table: a header row with pipes and a separator row under it
    if (l.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c): Align => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : "";
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const r = cells(lines[i]);
        rows.push(head.map((_, k) => parseInline(r[k] ?? "")));
        i++;
      }
      out.push({ t: "table", align: head.map((_, k) => align[k] ?? ""), head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    // a paragraph: up to a blank line or the start of another block (raw HTML is text in it)
    const para = [l.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      if (lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) break;
      para.push(lines[i].replace(/^ +/, ""));
      i++;
    }
    out.push({ t: "p", children: parseInline(para.join("\n")) });
  }
  return out;
}

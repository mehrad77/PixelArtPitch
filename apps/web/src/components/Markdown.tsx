// Renders lib/markdown.ts's AST as React elements: every string is a text node, so nothing in a doc is ever HTML.
// Headings start at h2 (the page owns the h1) and get ids under a prefix; a link to a listed doc opens inside the
// page, an http(s)/mailto link opens in a new tab, and any other link (an unlisted file, javascript:, data:) is text.

import { isCodeLang } from "@shabboo/kit/code";
import { CodeBlock, Table } from "@shabboo/kit/react";
import type { ReactNode } from "react";
import { docHref } from "../lib/docs.ts";
import { type Block, type Inline, linkKind, resolveRelative } from "../lib/markdown.ts";
import { Link } from "../lib/router.tsx";
import "./Markdown.css";

export type MarkdownLinks = {
  /** the doc being read, repo-relative ("docs/roles/writer.md"): relative links resolve against its folder */
  from: string;
  /** the docs the page can open; a link to anything else is text */
  known: ReadonlySet<string>;
  /** the prefix on heading ids, so a doc's ids never meet the page's */
  idPrefix: string;
};

function inline(xs: Inline[], l: MarkdownLinks, key = ""): ReactNode[] {
  return xs.map((x, i) => {
    const k = `${key}${i}`;
    switch (x.t) {
      case "text":
        return x.text;
      case "code":
        return (
          <code key={k} dir="ltr">
            {x.text}
          </code>
        );
      case "em":
        return <em key={k}>{inline(x.children, l, `${k}.`)}</em>;
      case "strong":
        return <strong key={k}>{inline(x.children, l, `${k}.`)}</strong>;
      case "del":
        return <del key={k}>{inline(x.children, l, `${k}.`)}</del>;
      case "br":
        return <br key={k} />;
      case "img":
        return x.alt ? (
          <span key={k} className="md-img">
            [{x.alt}]
          </span>
        ) : null;
      case "link":
        return <MdLink key={k} href={x.href} links={l} label={inline(x.children, l, `${k}.`)} />;
    }
    return null;
  });
}

function MdLink({ href, links, label }: { href: string; links: MarkdownLinks; label: ReactNode[] }) {
  const kind = linkKind(href);
  if (kind === "external")
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  if (kind === "anchor") return <a href={`#${links.idPrefix}${href.slice(1)}`}>{label}</a>;
  if (kind === "relative") {
    const r = resolveRelative(links.from, href);
    if (r && links.known.has(r.path)) {
      const hash = r.hash ? `#${links.idPrefix}${r.hash.slice(1)}` : "";
      return <Link href={docHref(r.path, hash)}>{label}</Link>;
    }
  }
  // not a doc the page lists (a source file, a folder) or not a safe link: its words, marked as a path
  return (
    <span className="md-unlinked" title={kind === "relative" ? href : undefined}>
      {label}
    </span>
  );
}

/** a column's alignment, logical: left and right follow the reading direction */
const alignStyle = (a: string) =>
  a ? { textAlign: (a === "left" ? "start" : a === "right" ? "end" : "center") as "start" } : undefined;

function block(b: Block, l: MarkdownLinks, k: string): ReactNode {
  switch (b.t) {
    case "h": {
      const level = Math.min(6, Math.max(2, b.level));
      const Tag = `h${level}` as "h2";
      return (
        <Tag key={k} id={`${l.idPrefix}${b.id}`} dir="auto">
          {inline(b.children, l)}
        </Tag>
      );
    }
    case "p":
      return (
        <p key={k} dir="auto">
          {inline(b.children, l)}
        </p>
      );
    case "hr":
      return <hr key={k} />;
    case "code":
      return (
        <CodeBlock key={k} code={b.text} lang={isCodeLang(b.lang) ? b.lang : undefined} label={b.lang || undefined} />
      );
    case "quote":
      return <blockquote key={k}>{blocks(b.children, l, `${k}.`)}</blockquote>;
    case "list": {
      const items = b.items.map((item, i) => (
        // a tight item (one paragraph) is its words, not a <p>
        // biome-ignore lint/suspicious/noArrayIndexKey: a doc's parts never reorder
        <li key={`${k}.${i}`} dir="auto">
          {item.length === 1 && item[0].t === "p" ? inline(item[0].children, l) : blocks(item, l, `${k}.${i}.`)}
        </li>
      ));
      return b.ordered ? (
        <ol key={k} start={b.start !== 1 ? b.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={k}>{items}</ul>
      );
    }
    case "table":
      return (
        <Table key={k} size="sm" className="md-table">
          <thead>
            <tr>
              {b.head.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a doc's parts never reorder
                <th key={`h${i}`} scope="col" dir="auto" style={alignStyle(b.align[i])}>
                  {inline(c, l)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a doc's parts never reorder
              <tr key={`r${j}`}>
                {r.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a doc's parts never reorder
                  <td key={`c${i}`} dir="auto" style={alignStyle(b.align[i])}>
                    {inline(c, l)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      );
  }
  return null;
}

const blocks = (bs: Block[], l: MarkdownLinks, key = "") => bs.map((b, i) => block(b, l, `${key}${i}`));

export function Markdown({ blocks: bs, links }: { blocks: Block[]; links: MarkdownLinks }) {
  return <div className="md">{blocks(bs, links)}</div>;
}

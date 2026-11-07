/**
 * Write generated text into any text file between begin and end marker comments, idempotently:
 *
 *   /* sprites:begin (anything here is kept) *\/
 *   ...generated...
 *   /* sprites:end *\/
 *
 * Only the text between the markers changes, so running the emitter twice is a no-op. The comment syntax is
 * configurable ({ open: "<!--", close: "-->" } for HTML, { open: "#", close: "" } for shell or YAML).
 */
import { readFileSync, writeFileSync } from "node:fs";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const C_STYLE = { open: "/*", close: "*/" };

/** The begin and end marker lines for a block, with a note on the begin marker. */
export function markers(name, { comment = C_STYLE, note = "" } = {}) {
  const close = comment.close ? ` ${comment.close}` : "";
  return {
    begin: `${comment.open} ${name}:begin${note ? ` ${note}` : ""}${close}`,
    end: `${comment.open} ${name}:end${close}`,
  };
}

/**
 * Locate a block: { at, start, end }, the begin marker's offset and the generated text between the markers (end-exclusive), with the
 * marker text, or null when the file has no such block.
 */
export function findBlock(text, name, { comment = C_STYLE } = {}) {
  const close = comment.close ? `[^\\n]*?${escapeRe(comment.close)}` : "[^\\n]*";
  const begin = new RegExp(`${escapeRe(comment.open)} ${escapeRe(name)}:begin\\b${close}\\r?\\n`);
  const b = begin.exec(text);
  if (!b) return null;
  const endMarker = markers(name, { comment }).end;
  const e = text.indexOf(endMarker, b.index + b[0].length);
  if (e < 0) throw new Error(`block "${name}": begin marker without "${endMarker}"`);
  return { at: b.index, start: b.index + b[0].length, end: e, beginMarker: b[0].replace(/\r?\n$/, ""), endMarker };
}

/** The generated text of a block, or null. */
export function readBlock(text, name, opts) {
  const f = findBlock(text, name, opts);
  return f ? text.slice(f.start, f.end) : null;
}

/**
 * Replace the body of block `name` in `text` with `body` (a trailing newline is added if missing). A file without the
 * block can adopt one: `adopt(text)` returns [start, end], the unmarked region to wrap in markers and replace
 * (start === end inserts). Without `adopt` a missing block throws. Returns the new text.
 */
export function replaceBlock(text, name, body, { comment = C_STYLE, note = "", adopt } = {}) {
  const content = body.endsWith("\n") ? body : `${body}\n`;
  const f = findBlock(text, name, { comment });
  if (f) {
    // a given note also refreshes the begin marker; without one the marker is kept as it is
    const begin = note ? markers(name, { comment, note }).begin : f.beginMarker;
    return `${text.slice(0, f.at)}${begin}\n${content}${text.slice(f.end)}`;
  }
  const region = adopt?.(text);
  if (!region) throw new Error(`block "${name}" not found (no "${markers(name, { comment }).begin}")`);
  const [start, end] = region;
  const m = markers(name, { comment, note });
  return `${text.slice(0, start)}${m.begin}\n${content}${m.end}\n${text.slice(end)}`;
}

/**
 * Write several blocks into a file. `blocks` maps a block name to its body, or to { body, adopt, note }.
 * With `check: true` nothing is written. Returns { changed: string[], text } naming the blocks whose text differs.
 */
export function emitBlocks(file, blocks, { comment = C_STYLE, check = false } = {}) {
  const before = readFileSync(file, "utf8");
  let text = before;
  const changed = [];
  for (const [name, spec] of Object.entries(blocks)) {
    const { body, adopt, note } = typeof spec === "string" ? { body: spec } : spec;
    const next = replaceBlock(text, name, body, { comment, note, adopt });
    if (next !== text) changed.push(name);
    text = next;
  }
  if (!check && text !== before) writeFileSync(file, text);
  return { changed, text };
}

// The live canvas (an experiment, Settings › Experimental): a Pixel Artist's answer as it streams is DrawOut JSON
// ({ notes, frames: [{ name, rows: ["..kk..", …] }] }). This reads the complete rows out of the text so far, so the
// growing grid can be painted a row at a time. Pure functions, no DOM.

export type DraftFrame = { name: string; rows: string[] };

/** a row is cells only: palette letters and "." (transparent) */
const ROW = /^[A-Za-z.]+$/;

/**
 * The frames whose rows have arrived whole, in order; a row still being written (no closing quote yet) is left out.
 * Tolerant of any order of `name` and `rows` inside a frame, and of text before or after the frames.
 */
export function draftFrames(text: string): DraftFrame[] {
  const at = text.indexOf('"frames"');
  if (at < 0) return [];
  const out: DraftFrame[] = [];
  let cur: DraftFrame | null = null;
  let inRows = false;
  let depth = 0;
  const re = /"name"\s*:\s*"([^"\\]*)"|"rows"\s*:\s*\[|"((?:[^"\\]|\\.)*)"|[{}\]]/g;
  re.lastIndex = at + 8;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const tok = m[0];
    if (tok === "{") {
      depth++;
      if (depth === 1) {
        cur = { name: "", rows: [] };
        out.push(cur);
      }
    } else if (tok === "}") {
      depth = Math.max(0, depth - 1);
      inRows = false;
    } else if (tok === "]") {
      // the rows end, or the frames do
      if (inRows) inRows = false;
      else if (depth === 0) break;
    } else if (m[1] !== undefined) {
      if (cur) cur.name ||= m[1];
    } else if (tok.startsWith('"rows"')) inRows = !!cur;
    else if (inRows && cur && m[2] !== undefined && ROW.test(m[2])) cur.rows.push(m[2]);
  }
  return out.filter((f) => f.rows.length > 0);
}

/** the frame to paint: the newest one with rows (the one being drawn now) */
export const liveFrame = (text: string): DraftFrame | null => draftFrames(text).at(-1) ?? null;

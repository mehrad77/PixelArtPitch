// The rough cut's contact sheet, frame by frame. packages/render's contactSheet lays one still per `every` seconds
// (the crew calls it with every = 1) into 6 columns of 320×180 frames at 1×, frame i taken at i·every + every/2; the
// last row may be partial. The grid is read back from the image's own size, so a sheet with another column count still
// steps; a sheet whose size isn't whole frames is shown whole. Pure, no React.
export const FRAME_W = 320;
export const FRAME_H = 180;

export type SheetGrid = {
  cols: number;
  rows: number;
  /** frames on the sheet */
  n: number;
  /** seconds between stills */
  every: number;
};
export type FrameRect = { x: number; y: number; w: number; h: number };

/**
 * The grid of a sheet `w`×`h` px for a film of `duration` s, or null when its size isn't whole frames (then the dialog
 * shows the sheet whole). Without a duration every cell counts as a frame.
 */
export function sheetGrid(w: number, h: number, duration?: number, every = 1): SheetGrid | null {
  if (!(w > 0 && h > 0)) return null;
  const cols = w / FRAME_W;
  const rows = h / FRAME_H;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const cells = cols * rows;
  const want = duration && duration > 0 ? Math.ceil(duration / every) : cells;
  // a partial last row: the film's frame count when it ends in the last row; a count that doesn't fit the sheet (the
  // film changed since it was drawn) trusts the sheet
  const n = want > (rows - 1) * cols && want <= cells ? want : cells;
  return { cols, rows, n, every };
}

/** where frame `i` sits on the sheet */
export const frameRect = (g: SheetGrid, i: number): FrameRect => ({
  x: (i % g.cols) * FRAME_W,
  y: Math.floor(i / g.cols) * FRAME_H,
  w: FRAME_W,
  h: FRAME_H,
});

/** the film time frame `i` was taken at */
export const frameTime = (g: SheetGrid, i: number) => i * g.every + g.every / 2;

/** the biggest whole-number scale that fits a frame into `room` px wide (and `tall` px high), at least 1 */
export const fitScale = (room: number, tall = Number.POSITIVE_INFINITY) =>
  Math.max(1, Math.floor(Math.min(room / FRAME_W, tall / FRAME_H)));

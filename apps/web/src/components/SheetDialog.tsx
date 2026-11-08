// The picture beside what needs you, full screen: the rough cut's contact sheet one frame at a time ("Frame 5 of 30 ·
// 0:04"), at a whole-number pixel scale, with ← → (mirrored in right-to-left), Home and End, and the buttons; "Whole
// sheet" shows it as drawn. A picture that isn't a sheet of whole frames (a scene's frame, a member's last drawing)
// shows whole. A kit Dialog: Esc or the close button shuts it and the focus goes back to the picture's button.
import { Button, Dialog, Icon } from "@shabboo/kit/react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { mss } from "../lib/human.ts";
import { FRAME_H, FRAME_W, fitScale, frameRect, frameTime, type SheetGrid, sheetGrid } from "../lib/sheet.ts";
import "./SheetDialog.css";

/** the picture as a button: pressing it opens the dialog */
export function PreviewButton({
  src,
  title,
  duration,
  className,
}: {
  src: string;
  /** the dialog's title: "Rough cut", "Scene 2" */
  title: string;
  /** the film's length, to count a contact sheet's frames */
  duration?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`preview-btn ${className ?? ""}`}
        aria-haspopup="dialog"
        aria-label={`${title}: view full screen`}
        onClick={() => setOpen(true)}
      >
        <img className="pixelated" src={src} alt="" />
        <span className="preview-btn-hint small" aria-hidden="true">
          View
        </span>
      </button>
      {open && (
        <SheetDialog
          src={src}
          title={title}
          duration={duration}
          onClose={() => {
            setOpen(false);
            requestAnimationFrame(() => btn.current?.focus());
          }}
        />
      )}
    </>
  );
}

export function SheetDialog({
  src,
  title,
  duration,
  onClose,
}: {
  src: string;
  title: string;
  duration?: number;
  onClose: () => void;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [i, setI] = useState(0);
  const [whole, setWhole] = useState(false);
  const [scale, setScale] = useState(2);
  const [room, setRoom] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    const im = new Image();
    im.decoding = "async";
    im.onload = () => live && setImg(im);
    im.onerror = () => live && setFailed(true);
    im.src = src;
    return () => {
      live = false;
    };
  }, [src]);

  const grid: SheetGrid | null = img ? sheetGrid(img.naturalWidth, img.naturalHeight, duration) : null;
  const n = grid?.n ?? 1;
  const at = Math.min(i, n - 1);

  // the biggest whole-number scale that fits the room the dialog gives (never a blurry in-between)
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const tall = Math.max(FRAME_H, window.innerHeight * 0.62);
      // the stage's padding is not room for the picture
      const pad = Number.parseFloat(getComputedStyle(el).paddingInlineStart) * 2 || 0;
      setScale(fitScale(el.clientWidth - pad, tall));
      setRoom(el.clientWidth - pad);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // one frame of the sheet, drawn into a 320×180 canvas that CSS scales in whole pixels
  // biome-ignore lint/correctness/useExhaustiveDependencies: the grid is derived from img each render; its size is the key
  useEffect(() => {
    const c = canvas.current?.getContext("2d");
    if (!c || !img || !grid || whole) return;
    const r = frameRect(grid, at);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, FRAME_W, FRAME_H);
    c.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, FRAME_W, FRAME_H);
  }, [img, grid?.cols, grid?.rows, at, whole]);

  const go = (d: number) => setI((x) => Math.max(0, Math.min(n - 1, Math.min(x, n - 1) + d)));
  const onKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    // Esc closes this dialog only (the browser closes the topmost), never the crew drawer it may sit in
    if (e.key === "Escape") {
      e.stopPropagation();
      return;
    }
    if (!grid || whole) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select")) return;
    // the arrows follow the reading direction: in right-to-left, → goes back
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const fwd = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === fwd) go(1);
    else if (e.key === back) go(-1);
    else if (e.key === "Home") setI(0);
    else if (e.key === "End") setI(n - 1);
    else return;
    e.preventDefault();
  };

  const label = grid ? `Frame ${at + 1} of ${n} · ${mss(frameTime(grid, at))}` : "";
  return (
    // the keys work anywhere in the dialog (the close button has the focus first), so nobody has to find the buttons
    <Dialog
      id={`sheet-${id}`}
      title={title}
      size="lg"
      className="sheet-dialog"
      open
      onClose={(e) => {
        // React passes a nested dialog's close up its tree: the crew drawer around it must not close too
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={onKey}
    >
      <div className="sheet">
        <div className="sheet-stage" ref={stage} data-whole={whole || !grid ? "" : undefined}>
          {failed ? (
            <p className="small muted" role="status">
              This picture didn't load. Close it and try again in a moment.
            </p>
          ) : !img ? (
            <p className="small muted" role="status" aria-busy="true">
              Loading the picture…
            </p>
          ) : grid && !whole ? (
            <canvas
              ref={canvas}
              width={FRAME_W}
              height={FRAME_H}
              className="pixelated sheet-frame"
              style={{ inlineSize: FRAME_W * scale }}
              role="img"
              aria-label={`${title}, ${label}`}
            />
          ) : (
            <img
              className="pixelated sheet-whole"
              src={src}
              alt={grid ? `${title}: all ${n} frames` : title}
              // a small picture grows by whole pixels; one wider than the room fits it
              style={
                room > img.naturalWidth
                  ? { inlineSize: img.naturalWidth * Math.floor(room / img.naturalWidth) }
                  : { inlineSize: "100%" }
              }
            />
          )}
        </div>
        {grid && (
          <div className="sheet-bar">
            {!whole && (
              <div className="sheet-steps">
                <Button size="sm" variant="ghost" onClick={() => go(-1)} aria-label="Previous frame">
                  <Icon name="arrow-left" />
                </Button>
                <p className="sheet-count mono small" aria-live="polite">
                  <bdi>{label}</bdi>
                </p>
                <Button size="sm" variant="ghost" onClick={() => go(1)} aria-label="Next frame">
                  <Icon name="arrow-right" />
                </Button>
              </div>
            )}
            <Button size="sm" variant="quiet" aria-pressed={whole} onClick={() => setWhole((w) => !w)}>
              Whole sheet
            </Button>
          </div>
        )}
        {grid && !whole && (
          <p className="sheet-hint small muted">
            <bdi>← →</bdi> step through the frames · <bdi>Esc</bdi> closes
          </p>
        )}
      </div>
    </Dialog>
  );
}

// Long text, kept short: two lines, then "More". The button only shows when the text overflows.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import "./Clamp.css";

export function Clamp({
  children,
  lines = 2,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  lines?: number;
  className?: string;
  as?: "p" | "div";
}) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOver(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return (
    <div className={`clamp${className ? ` ${className}` : ""}`}>
      <Tag
        ref={ref as never}
        className="clamp-text"
        data-open={open ? "" : undefined}
        style={{ ["--clamp-lines" as string]: lines }}
      >
        {children}
      </Tag>
      {(over || open) && (
        <button type="button" className="clamp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

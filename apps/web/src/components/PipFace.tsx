// Pip's face: the crew's two-glyph language on an accent squircle with a pixel crown: Pip leads the crew, and its face
// never reads as one more round crew disc.
// Idle ◠ ◠, listening o o, thinking (a stepped glance, still under reduced motion), happy ^ ^, sorry ; ;. A dot
// on the ring says Pip has something new. Decorative: the caller names it.
import { useEffect, useState } from "react";
import type { PipMood } from "../lib/pip.ts";
import "./PipFace.css";

const GLYPH: Record<PipMood, string> = {
  idle: "◠ ◠",
  listening: "o o",
  thinking: "◠ ◠",
  happy: "^ ^",
  sorry: "; ;",
};
// thinking: the big face glances up and to each side; the small ones only blink, so nothing moves in a 24px disc
const THINK = ["◠ ◠", "◠ ◠", "- -", "◠ ◠"];
const GLANCE = ["up-start", "up-end", "", "up-end"] as const;
const BLINK = ["◠ ◠", "◠ ◠", "◠ ◠", "- -"];

export const PIP_MOOD_WORD: Record<PipMood, string> = {
  idle: "",
  listening: "listening",
  thinking: "thinking",
  happy: "",
  sorry: "",
};

export function useReducedMotion() {
  const query = () => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null);
  const [r, setR] = useState(() => query()?.matches ?? false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribes once
  useEffect(() => {
    const q = query();
    if (!q) return;
    const on = () => setR(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return r;
}

export function PipFace({
  mood,
  size = "md",
  dot = false,
}: {
  mood: PipMood;
  /** xs/sm: headers and the crew button; row: first in the crew row; md/lg: larger stand-alone faces */
  size?: "xs" | "sm" | "row" | "md" | "lg";
  dot?: boolean;
}) {
  const still = useReducedMotion();
  const [n, setN] = useState(0);
  const moving = mood === "thinking" && !still;
  const small = size === "xs" || size === "sm";
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setN((x) => x + 1), small ? 600 : 700);
    return () => clearInterval(t);
  }, [moving, small]);
  const frames = small ? BLINK : THINK;
  const glyphs = moving ? frames[n % frames.length] : GLYPH[mood];
  return (
    <span
      className="pip-face"
      data-mood={mood}
      data-size={size}
      data-glance={moving && !small ? GLANCE[n % GLANCE.length] || undefined : undefined}
      aria-hidden="true"
    >
      <span className="pip-face-crown">
        <svg viewBox="0 0 7 5" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M0 0h1v2H0zM3 0h1v2H3zM6 0h1v2H6zM1 1h1v1H1zM5 1h1v1H5zM0 2h7v3H0z" />
        </svg>
      </span>
      <span className="pip-face-glyphs">{glyphs}</span>
      {dot && <span className="pip-face-dot" />}
    </span>
  );
}

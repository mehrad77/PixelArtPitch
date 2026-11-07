// The record page's big now/next prompter, synced to the cue times (from the WebVTT, or the timeline).
import "./Teleprompter.css";

export type PromptCue = { id?: string; start: number; end: number; text: string };

export function Teleprompter({ cues, t, countIn }: { cues: PromptCue[]; t: number; countIn: number | null }) {
  let i = cues.findIndex((c) => t >= c.start && t <= c.end);
  const between = i < 0;
  if (between) i = cues.findIndex((c) => c.start > t);
  const now = !between ? cues[i] : null;
  const next = between ? cues[i] : cues[i + 1];
  return (
    <div className="prompter" aria-live="off">
      {countIn != null ? (
        <p className="prompter-count">
          <span className="visually-hidden">Starting in </span>
          {countIn}
        </p>
      ) : (
        <>
          <p className="prompter-now">{now ? now.text : <span className="muted">…</span>}</p>
          <p className="prompter-next">{next ? `Next: ${next.text}` : between && !next ? "End of script" : " "}</p>
        </>
      )}
    </div>
  );
}

/** parse a WebVTT file into cues */
export function parseVtt(text: string): PromptCue[] {
  const toSec = (s: string) => {
    const p = s.trim().split(":").map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  return text
    .replace(/\r/g, "")
    .split(/\n\n+/)
    .flatMap((block) => {
      const lines = block.trim().split("\n");
      const k = lines.findIndex((l) => l.includes("-->"));
      if (k < 0) return [];
      const [a, b] = lines[k].split("-->");
      return [{ start: toSec(a), end: toSec(b.trim().split(/\s+/)[0]), text: lines.slice(k + 1).join(" ") }];
    });
}

// An action that says what it will cause before it runs. The effect line (from effectOf in lib/human.ts) sits
// beside the button; a costly or destructive one asks again in place: the button becomes "Yes, …" and Cancel.
// Never a modal, and nothing opens on its own.
import { Button } from "@shabboo/kit/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Effect } from "../lib/human.ts";
import { Link } from "../lib/router.tsx";
import "./EffectAction.css";

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

export function EffectButton({
  label,
  effect,
  onRun,
  variant = "primary",
  className,
  check,
}: {
  label: string;
  effect: Effect;
  onRun: () => Promise<void> | void;
  variant?: "primary" | "ghost" | "quiet" | "danger";
  className?: string;
  /** runs before asking or running; false stops here (the caller said what's missing) */
  check?: () => boolean;
}) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const moved = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the button swaps (asking changes)
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    // the pressed button was replaced: focus its stand-in (Yes, or the action again after Cancel)
    wrap.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [asking]);
  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onRun();
      setAsking(false);
    } catch (e) {
      setErr(`${(e as Error).message}. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="effect-action" ref={wrap}>
      {asking ? (
        <>
          <Button
            size="sm"
            variant="primary"
            onClick={run}
            aria-busy={busy ? "true" : undefined}
            aria-describedby={effect.text ? `${id}-fx` : undefined}
          >
            Yes, {lower(label)}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              moved.current = true;
              setAsking(false);
            }}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          className={className}
          size="sm"
          variant={variant}
          aria-busy={busy ? "true" : undefined}
          aria-describedby={effect.text ? `${id}-fx` : undefined}
          onClick={() => {
            if (check && !check()) return;
            if (!effect.confirm) return run();
            moved.current = true;
            setAsking(true);
          }}
        >
          {label}
        </Button>
      )}
      {effect.text && (
        <span className="effect-line" id={`${id}-fx`}>
          {effect.text}
          {effect.href && (
            <>
              {" "}
              <Link href={effect.href}>Open Settings › Roles</Link>
            </>
          )}
        </span>
      )}
      {err && (
        <span className="decision-error effect-error" role="status">
          {err}
        </span>
      )}
    </span>
  );
}

// Direct controls on a crew member, one deliberate step away: Pip keeps the crew in step, so the default path is
// "Ask Pip about this"; anyone who wants to steer an agent themselves opens this. The choice is remembered.
import { Disclosure } from "@shabboo/kit/react";
import { type ReactNode, useState } from "react";
import { directOpened, rememberDirect } from "../lib/pip.ts";

export function DirectControls({
  who,
  summary,
  children,
  className,
}: {
  /** "the animator", "the crew" */
  who: string;
  summary?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open] = useState(directOpened);
  return (
    <Disclosure
      size="sm"
      summary={summary ?? `Talk to ${who} directly`}
      open={open}
      className={`direct${className ? ` ${className}` : ""}`}
      onToggle={(e) => rememberDirect((e.currentTarget as HTMLDetailsElement).open)}
    >
      <p className="small muted direct-note">
        Pip keeps the crew in step. Messages here go straight to {who} and Pip won't plan around them.
      </p>
      {children}
    </Disclosure>
  );
}

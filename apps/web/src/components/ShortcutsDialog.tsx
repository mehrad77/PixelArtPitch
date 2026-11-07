import { Dialog, Kbd } from "@shabboo/kit/react";
import type { ReactNode } from "react";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const cmd = isMac ? "⌘" : "Ctrl";

export const SHORTCUTS: [ReactNode, string][] = [
  [<Kbd key="sp">Space</Kbd>, "Play or pause"],
  [
    <>
      <Kbd>J</Kbd> <Kbd>K</Kbd> <Kbd>L</Kbd>
    </>,
    "Shuttle back, stop, forward (press again for 2× and 4×)",
  ],
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd>
    </>,
    "One frame back or forward",
  ],
  [
    <>
      <Kbd>Shift</Kbd> + <Kbd>←</Kbd> <Kbd>→</Kbd>
    </>,
    "One second back or forward",
  ],
  [
    <>
      <Kbd>↑</Kbd> <Kbd>↓</Kbd>
    </>,
    "Previous or next scene",
  ],
  [
    <>
      <Kbd>Home</Kbd> <Kbd>End</Kbd>
    </>,
    "Start or end",
  ],
  [
    <>
      <Kbd>I</Kbd> <Kbd>O</Kbd>
    </>,
    "Set the In or Out point (press again at the same spot to clear)",
  ],
  [<Kbd key="m">M</Kbd>, "Add a note at the playhead or the In/Out range"],
  [<Kbd key="bs">\</Kbd>, "Before and after the last change"],
  [<Kbd key="q">Q</Kbd>, "Next question in the Inbox"],
  [<Kbd key="c">C</Kbd>, "Open the crew: what each agent is doing (on every page)"],
  [
    <>
      <Kbd>{cmd}</Kbd> + <Kbd>.</Kbd>
    </>,
    "Pause the crew after its current step",
  ],
  [<Kbd key="?">?</Kbd>, "This list"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog id="shortcuts" title="Keyboard shortcuts" open onClose={onClose} closeLabel="Close" size="md">
      <p className="muted small">They work outside text fields. Nothing approves on a single key.</p>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, what]) => (
            <tr key={what}>
              <th scope="row">{k}</th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

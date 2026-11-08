// Scroll to what needs the person (PIP-JOURNEY §4, "Scroll to attention"): when a new ask arrives, the page glides to
// it (smooth, centred; instant under reduced motion), unless the person is typing, when a small "Needs you" pill says
// where it is instead. Q and "Show me" use the same helper. A load or a reconnect never scrolls: the keys seen then
// are the baseline. The diff is pure (tested in node); the scroll is a DOM helper.

/** the keys in `next` that `seen` hasn't had; `seen` null is the first look (the baseline), which reports none */
export function newKeys(seen: ReadonlySet<string> | null, next: readonly string[]): string[] {
  if (!seen) return [];
  return next.filter((k) => !seen.has(k));
}

/** the person is typing: a text field, a textarea, a select or an editable region has the focus */
export function isTyping(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement)
    return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "image", "color"].includes(el.type);
  return false;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** where the element is against the window: "in" view, "above" or "below" it */
export function whereIs(el: Element | null): "in" | "above" | "below" | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 44;
  if (r.bottom < top + 24) return "above";
  if (r.top > window.innerHeight - 24) return "below";
  return "in";
}

/** scroll an element into view the shared way: smooth, instant under reduced motion */
export function glideTo(el: Element | null | undefined, block: ScrollLogicalPosition = "center") {
  el?.scrollIntoView({ block, behavior: reduced() ? "auto" : "smooth" });
}

/**
 * Bring what needs the person into view: smooth and centred, instant under reduced motion. With `focus` (the person
 * asked: Q, "Show me", the pill), its first button takes the focus without a second jump. A modal that doesn't hold the
 * target (the crew drawer) keeps the page still. Returns whether it scrolled.
 */
export function scrollToNeed(opts: { focus?: boolean; target?: HTMLElement | null } = {}): boolean {
  if (typeof document === "undefined") return false;
  const card = opts.target ?? document.getElementById("needs-you");
  if (!card) return false;
  const modal = document.querySelector("dialog[open]");
  if (modal && !modal.contains(card)) return false;
  glideTo(card, "center");
  if (opts.focus) (card.querySelector<HTMLElement>(".needs-primary") ?? card).focus({ preventScroll: true });
  return true;
}

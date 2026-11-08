// The crew channel in words: who said what to whom, the bubble over a face, and Pip's one-sentence summary. Pure, no
// client (channel.ts re-exports it).
import { ROLE_LABEL } from "./derive.ts";
import { memberOf, sentence, theMember } from "./human.ts";
import type { ChannelMsg, RoleT } from "./types.ts";

export const isPip = (who: string) => who === "pip";
/** the crew member id a sender maps to ("pip", or a CREW id) */
export const memberIdOf = (who: string) => (isPip(who) ? "pip" : memberOf(who as RoleT).id);
export const nameOf = (who: string) =>
  isPip(who)
    ? "Pip"
    : who === "person" || who === "user"
      ? "you"
      : who === "crew"
        ? "the crew"
        : who === "librarian"
          ? theMember(who)
          : `the ${(ROLE_LABEL[who as RoleT] ?? memberOf(who as RoleT).label).toLowerCase()}`;
/** Pip's word to the whole crew ("Paused the crew: …", "Back to work: …") is already a sentence from Pip */
const toCrew = (m: ChannelMsg) => isPip(m.from) && m.to === "crew";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const KIND_WORD: Record<ChannelMsg["kind"], string> = {
  brief: "briefed",
  report: "reported",
  ask: "asked",
  answer: "answered",
};

/** "Pip briefed the director", "The animator reported" */
export const headOf = (m: ChannelMsg) =>
  `${cap(nameOf(m.from))} ${KIND_WORD[m.kind]}${m.kind === "brief" || m.kind === "answer" ? ` ${nameOf(m.to)}` : ""}`;

/** the bubble over the sender's face */
export function bubbleOf(m: ChannelMsg): string {
  if (toCrew(m)) return m.text;
  if (isPip(m.from)) {
    const to = nameOf(m.to).replace(/^the /, "the ");
    return m.kind === "answer" ? `Told ${to}: ${m.text}` : `Asked ${to}: ${m.text}`;
  }
  return m.text;
}

/** one plain sentence for Pip's line: what's happening behind the scenes lately, or "" */
export function channelSummary(msgs: ChannelMsg[], withinMin = 15): string {
  const recent = msgs.filter((m) => Date.now() - Date.parse(m.at) < withinMin * 60_000);
  const last = recent.at(-1);
  if (!last) return "";
  if (toCrew(last)) return sentence(last.text);
  if (isPip(last.from))
    return `I ${last.kind === "answer" ? "answered" : "briefed"} ${nameOf(last.to)}: ${sentence(last.text)}`;
  return `${cap(nameOf(last.from))} ${last.kind === "ask" ? "asked me" : "reported"}: ${sentence(last.text)}`;
}

/** the messages between Pip and one member */
export const withMember = (msgs: ChannelMsg[], roles: string[]) =>
  msgs.filter((m) => roles.includes(m.from) || roles.includes(m.to));

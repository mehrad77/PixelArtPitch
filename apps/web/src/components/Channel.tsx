// "Behind the scenes": the crew channel as a quiet conversation between Pip and the crew. Collapsed by default; in a
// member's pane it shows only that member's messages with Pip. History comes from GET /api/p/:id/channel, live
// messages from the project stream.
import { Disclosure } from "@shabboo/kit/react";
import { headOf, isPip, useChannel, withMember } from "../lib/channel.ts";
import { clock } from "../lib/format.ts";
import { memberOf } from "../lib/human.ts";
import type { ChannelMsg, RoleT } from "../lib/types.ts";
import "./Channel.css";
import { CrewFace } from "./CrewStrip.tsx";
import { PipFace } from "./PipFace.tsx";

export function BehindTheScenes({
  projectId,
  roles,
  label,
  only,
}: {
  projectId: string | null;
  /** only this member's messages with Pip */
  roles?: string[];
  label?: string;
  /** exactly these messages (one instance's, PIP-JOURNEY §3.3) */
  only?: ChannelMsg[];
}) {
  const all = useChannel(projectId);
  if (!projectId) return null;
  const msgs = only ?? (roles ? withMember(all, roles) : all);
  if ((roles || only) && !msgs.length) return null;
  const title = label ?? (roles || only ? "With Pip" : "Behind the scenes");
  return (
    <Disclosure size="sm" summary={`${title}${msgs.length ? ` (${msgs.length})` : ""}`} className="channel">
      {msgs.length === 0 ? (
        <p className="small muted">Nothing yet. When Pip directs the crew, it shows here.</p>
      ) : (
        <ol className="channel-list">
          {msgs.map((m) => (
            <li key={m.id} className="channel-msg" data-from={isPip(m.from) ? "pip" : "crew"}>
              <span className="channel-face" aria-hidden="true">
                {isPip(m.from) ? (
                  <PipFace mood="idle" size="xs" />
                ) : (
                  <CrewFace member={memberOf(m.from as RoleT)} mood="idle" />
                )}
              </span>
              <div className="channel-body">
                <p className="channel-head small">
                  <bdi>{headOf(m)}</bdi>
                  <time className="muted" dateTime={m.at}>
                    <bdi>{clock(new Date(m.at))}</bdi>
                  </time>
                </p>
                <p className="channel-text" dir="auto">
                  {m.text}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Disclosure>
  );
}

import { Badge, Button, Callout, Checkbox, Disclosure, Field, Fieldset, Form, Radio } from "@shabboo/kit/react";
import { type FormEvent, useMemo, useState } from "react";
import { client } from "../lib/client.ts";
import { clock, duration, usd } from "../lib/format.ts";
import { navigate } from "../lib/router.tsx";
import type { Involvement, Profile, ProjectT } from "../lib/types.ts";

type Brief = ProjectT["brief"];
type RefType = Brief["references"][number]["type"];
type Rights = Brief["references"][number]["rights"];
type RefRow = { key: string; file: File; type: RefType; rights: Rights; note: string };

const PURPOSES: { id: Brief["purpose"]; label: string }[] = [
  { id: "pitch", label: "Pitch" },
  { id: "application", label: "Application" },
  { id: "launch", label: "Launch" },
  { id: "social", label: "Social" },
  { id: "other", label: "Other" },
];
const LENGTHS = [15, 30, 60, 90, 120];
const REF_TYPES: { id: RefType; label: string }[] = [
  { id: "likeness", label: "Likeness of a person" },
  { id: "logo", label: "Logo or trademark" },
  { id: "style", label: "Style reference" },
  { id: "as-is", label: "Use as-is" },
  { id: "sound", label: "Sound" },
  { id: "voice", label: "Voice" },
];
const RIGHTS: { id: Rights; label: string }[] = [
  { id: "mine", label: "Mine" },
  { id: "licensed", label: "Licensed" },
  { id: "unsure", label: "Not sure" },
];
/** rough per-60-second cost and minutes, by profile; the server's estimate replaces this once it has one */
const RATE: Record<Exclude<Profile, "custom">, { usd: [number, number]; min: [number, number] }> = {
  best: { usd: [3.8, 6.2], min: [25, 40] },
  balanced: { usd: [1.9, 3.4], min: [20, 35] },
  local: { usd: [0, 0.4], min: [50, 90] },
};
const INVOLVE_WAIT: Record<Involvement, number> = { every: 1.3, key: 1.1, auto: 1 };

function guessType(file: File): RefType {
  const n = file.name.toLowerCase();
  if (file.type.startsWith("audio/")) return /voice|vo|narrat/.test(n) ? "voice" : "sound";
  if (/logo|brand|mark/.test(n)) return "logo";
  if (/face|portrait|me\b|selfie|headshot/.test(n)) return "likeness";
  return "style";
}

export function ComposerPage({ first = false }: { first?: boolean }) {
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [purpose, setPurpose] = useState<Brief["purpose"]>("pitch");
  const [length, setLength] = useState(60);
  const [narration, setNarration] = useState<Brief["narration"]>("user");
  const [cap, setCap] = useState("6");
  const [askAt80, setAskAt80] = useState(true);
  const [deadline, setDeadline] = useState("");
  const [involvement, setInvolvement] = useState<Involvement>("key");
  const [profile, setProfile] = useState<Exclude<Profile, "custom">>("balanced");
  const [pace, setPace] = useState<"calm" | "brisk">("calm");
  const [iconsFirst, setIconsFirst] = useState(true);
  const [hold, setHold] = useState("3");
  const [endCard, setEndCard] = useState(true);
  const [refs, setRefs] = useState<RefRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; fix?: string } | null>(null);

  const est = useMemo(() => {
    const r = RATE[profile];
    const f = length / 60;
    const w = INVOLVE_WAIT[involvement];
    return {
      usd: [r.usd[0] * f, r.usd[1] * f] as const,
      min: [r.min[0] * Math.max(0.5, f) * w, r.min[1] * Math.max(0.5, f) * w] as const,
    };
  }, [profile, length, involvement]);
  const capNum = Number(cap);
  const now = Date.now();
  const readyBy = [new Date(now + est.min[0] * 60000), new Date(now + est.min[1] * 60000)];
  const deadlineMs = deadline ? Date.parse(deadline) : null;

  const onFiles = (list: FileList | null) => {
    if (!list) return;
    const add = [...list].map((file, i) => ({
      key: `${file.name}-${file.size}-${Date.now()}-${i}`,
      file,
      type: guessType(file),
      rights: "unsure" as Rights,
      note: "",
    }));
    setRefs((r) => [...r, ...add]);
  };
  const setRef = (key: string, patch: Partial<RefRow>) =>
    setRefs((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!idea.trim()) errs["c-idea"] = "Describe the idea in a sentence or two, so the crew knows what to pitch.";
    if (!Number.isFinite(capNum) || capNum <= 0) errs["c-cap"] = "Enter a budget cap above $0, for example 6.";
    else if (capNum > 10000) errs["c-cap"] = "Keep the cap at $10,000 or less.";
    if (deadlineMs != null && Number.isFinite(deadlineMs) && deadlineMs < now)
      errs["c-deadline"] = "Pick a time later than now, or clear the deadline.";
    const h = Number(hold);
    if (!Number.isFinite(h) || h < 0 || h > 10) errs["c-hold"] = "Hold the first frame for 0 to 10 seconds.";
    setErrors(errs);
    const firstBad = Object.keys(errs)[0];
    if (firstBad) {
      if (firstBad === "c-hold")
        (document.getElementById("c-style") as HTMLDetailsElement | null)?.setAttribute("open", "");
      requestAnimationFrame(() => document.getElementById(firstBad)?.focus());
      return;
    }
    setBusy(true);
    setFailure(null);
    const brief: Brief = {
      idea: idea.trim(),
      purpose,
      audience: "",
      ask: "",
      lengthSec: length,
      tone: [`${pace} pace`, ...(iconsFirst ? ["icons first"] : []), `hold ${h} s`, ...(endCard ? ["end card"] : [])],
      mustSay: [],
      mustAvoid: [],
      narration,
      involvement,
      deadline: deadlineMs ? new Date(deadlineMs).toISOString() : undefined,
      references: refs.map((r) => ({ file: r.file.name, type: r.type, rights: r.rights, note: r.note })),
    };
    try {
      const name =
        title.trim() ||
        idea
          .trim()
          .split(/[.!?\n]/)[0]
          .slice(0, 60);
      const { id } = await client.createProject({ title: name, brief, budgetUsd: capNum });
      // POST /api/projects takes no profile or ask-at; set them with one patch before the crew starts
      const st = await client.project(id).catch(() => null);
      if (st)
        await client
          .patch(id, {
            ops: [
              { op: "replace", path: "/crew/profile", value: profile },
              { op: "replace", path: "/budget/askAtFraction", value: askAt80 ? 0.8 : 1 },
            ],
            reason: "Profile and budget question from the composer",
            baseRev: st.rev,
          })
          .catch(() => {});
      await client.crewRun(id).catch(() => {});
      navigate(`/p/${encodeURIComponent(id)}/brief`);
    } catch (err) {
      const ex = err as Error & { fix?: string };
      setFailure({ message: ex.message, fix: ex.fix });
      setBusy(false);
    }
  };

  const errList = Object.entries(errors).map(([id, message]) => ({ id, message }));

  return (
    <main id="main" className="page-narrow composer">
      <h1>{first ? "Make your first pitch video" : "New project"}</h1>
      <p className="muted">
        Describe the idea. The crew plans the script, the art and the sound, and asks you at the gates you choose.
      </p>
      <Form
        noValidate
        onSubmit={submit}
        focusSummary={false}
        error={
          errList.length ? (errList.length === 1 ? "One thing to fix" : `${errList.length} things to fix`) : undefined
        }
        errors={errList}
        actions={
          <Button type="submit" variant="primary" size="lg" aria-describedby={failure ? "c-failure" : undefined}>
            {busy ? "Starting…" : "Start project"}
          </Button>
        }
      >
        <Field
          id="c-idea"
          label="Idea"
          control="textarea"
          rows={4}
          required
          value={idea}
          onChange={(e) => setIdea(e.currentTarget.value)}
          placeholder="A live map of night-market stalls, for walkers and vendors"
          hint="What it is, who it's for, and what you want viewers to do."
          error={errors["c-idea"]}
        />
        <Fieldset id="c-purpose" legend="Purpose" layout="row">
          {PURPOSES.map((p) => (
            <Radio
              key={p.id}
              id={`c-purpose-${p.id}`}
              name="purpose"
              variant="chip"
              indicator={false}
              label={p.label}
              value={p.id}
              checked={purpose === p.id}
              onChange={() => setPurpose(p.id)}
            />
          ))}
        </Fieldset>
        <Field
          id="c-title"
          label="Project name"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          hint="Optional. Taken from the idea when empty."
          autoComplete="off"
        />
        <Fieldset id="c-length" legend="Length" layout="row" hint="Seconds of video, before the end card.">
          {LENGTHS.map((l) => (
            <Radio
              key={l}
              id={`c-len-${l}`}
              name="length"
              variant="chip"
              indicator={false}
              label={`${l} s`}
              value={String(l)}
              checked={length === l}
              onChange={() => setLength(l)}
            />
          ))}
        </Fieldset>
        <Fieldset id="c-narration" legend="Narration">
          <Radio
            id="c-nar-user"
            name="narration"
            label="I'll record it"
            hint="A record page with a teleprompter; the Editor aligns your take."
            checked={narration === "user"}
            onChange={() => setNarration("user")}
          />
          <Radio
            id="c-nar-tts"
            name="narration"
            label="AI voice"
            checked={narration === "tts"}
            onChange={() => setNarration("tts")}
          />
          <Radio
            id="c-nar-none"
            name="narration"
            label="None"
            hint="Captions and music only."
            checked={narration === "none"}
            onChange={() => setNarration("none")}
          />
        </Fieldset>
        <div className="field-group">
          <Field
            id="c-cap"
            label="Budget cap ($)"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.5"
            value={cap}
            onChange={(e) => setCap(e.currentTarget.value)}
            error={errors["c-cap"]}
            aria-describedby="c-estimate"
          />
          <p id="c-estimate" className="estimate" aria-live="polite">
            Estimated {usd(est.usd[0])} to {usd(est.usd[1])} for {length} s on {profile}.
            {Number.isFinite(capNum) &&
              capNum > 0 &&
              capNum < est.usd[0] &&
              " The cap is below the estimate: the crew will ask before it runs out."}
          </p>
          <Checkbox
            id="c-ask80"
            label="Ask me at 80% of the cap"
            checked={askAt80}
            onChange={(e) => setAskAt80(e.currentTarget.checked)}
          />
        </div>
        <div className="field-group">
          <Field
            id="c-deadline"
            label="Deadline"
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.currentTarget.value)}
            hint="Optional."
            error={errors["c-deadline"]}
            aria-describedby="c-eta"
          />
          <p id="c-eta" className="estimate" aria-live="polite">
            Ready in about {duration(est.min[0] * 60)} to {duration(est.min[1] * 60)} (between {clock(readyBy[0])} and{" "}
            {clock(readyBy[1])}).
            {deadlineMs != null &&
              deadlineMs > now &&
              deadlineMs < readyBy[1].getTime() &&
              " The deadline falls inside that range, so the crew may ask you to trim."}
          </p>
        </div>
        <Fieldset id="c-involvement" legend="How involved do you want to be">
          <Radio
            id="c-inv-every"
            name="involvement"
            label="Every gate"
            hint="You approve the brief, script, animatic, rough cut and final."
            checked={involvement === "every"}
            onChange={() => setInvolvement("every")}
          />
          <Radio
            id="c-inv-key"
            name="involvement"
            label="Key gates"
            hint="You pick the script angle and approve the animatic and the final."
            checked={involvement === "key"}
            onChange={() => setInvolvement("key")}
          />
          <Radio
            id="c-inv-auto"
            name="involvement"
            label="Run on its own"
            hint="The Producer decides; you get the result and a list of choices it made."
            checked={involvement === "auto"}
            onChange={() => setInvolvement("auto")}
          />
        </Fieldset>
        <Fieldset
          id="c-profile"
          legend="Model profile"
          layout="row"
          hint="Which models the crew uses. Fine-tune roles in Settings."
        >
          {(["best", "balanced", "local"] as const).map((p) => (
            <Radio
              key={p}
              id={`c-prof-${p}`}
              name="profile"
              variant="chip"
              indicator={false}
              label={p === "best" ? "Best" : p === "balanced" ? "Balanced" : "Local"}
              checked={profile === p}
              onChange={() => setProfile(p)}
            />
          ))}
        </Fieldset>
        <Disclosure
          id="c-style"
          summary={`Style: ${pace} pace, ${iconsFirst ? "icons first, " : ""}${hold} s hold${endCard ? ", end card" : ""}`}
          boxed
        >
          <div className="stack-3">
            <Fieldset id="c-pace" legend="Pace" layout="row">
              <Radio
                id="c-pace-calm"
                name="pace"
                variant="chip"
                indicator={false}
                label="Calm"
                checked={pace === "calm"}
                onChange={() => setPace("calm")}
              />
              <Radio
                id="c-pace-brisk"
                name="pace"
                variant="chip"
                indicator={false}
                label="Brisk"
                checked={pace === "brisk"}
                onChange={() => setPace("brisk")}
              />
            </Fieldset>
            <Checkbox
              id="c-icons"
              label="Icons first"
              hint="Show an icon before the words that name it."
              checked={iconsFirst}
              onChange={(e) => setIconsFirst(e.currentTarget.checked)}
            />
            <Field
              id="c-hold"
              label="Hold the first frame (s)"
              type="number"
              min={0}
              max={10}
              step="0.5"
              value={hold}
              onChange={(e) => setHold(e.currentTarget.value)}
              error={errors["c-hold"]}
            />
            <Checkbox
              id="c-endcard"
              label="End card"
              hint="Name, link and the ask, held for 4 s."
              checked={endCard}
              onChange={(e) => setEndCard(e.currentTarget.checked)}
            />
          </div>
        </Disclosure>
        <section className="refs" aria-labelledby="c-refs-title">
          <h2 id="c-refs-title" className="h3">
            References
          </h2>
          <Field
            id="c-files"
            label="Add files"
            type="file"
            multiple
            accept="image/*,audio/*,video/*"
            hint="Pictures, logos, sounds or a voice sample. They stay in this project's folder."
            onChange={(e) => {
              onFiles((e.currentTarget as HTMLInputElement).files);
              e.currentTarget.value = "";
            }}
          />
          {refs.length > 0 && (
            <ol className="ref-list">
              {refs.map((r, i) => {
                const priv = r.type === "likeness" || r.type === "logo";
                return (
                  <li key={r.key} className="ref-row">
                    <div className="ref-head">
                      <span className="mono ltr">{r.file.name}</span>
                      {priv && (
                        <Badge tone="info" variant="pill" caps={false} aria-describedby={`ref-why-${i}`}>
                          Private to this project
                        </Badge>
                      )}
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => setRefs((x) => x.filter((y) => y.key !== r.key))}
                        aria-label={`Remove ${r.file.name}`}
                      >
                        Remove
                      </Button>
                    </div>
                    {priv && (
                      <p id={`ref-why-${i}`} className="muted small">
                        {r.type === "likeness" ? "A real person's likeness" : "A logo or trademark"} and anything drawn
                        from it never enters the public library.
                      </p>
                    )}
                    <div className="ref-fields">
                      <Field
                        id={`ref-type-${i}`}
                        label="Type"
                        control="select"
                        size="sm"
                        value={r.type}
                        onChange={(e) => setRef(r.key, { type: e.currentTarget.value as RefType })}
                      >
                        {REF_TYPES.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </Field>
                      <Field
                        id={`ref-rights-${i}`}
                        label="Rights"
                        control="select"
                        size="sm"
                        value={r.rights}
                        onChange={(e) => setRef(r.key, { rights: e.currentTarget.value as Rights })}
                      >
                        {RIGHTS.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </Field>
                      <Field
                        id={`ref-note-${i}`}
                        label="Note"
                        size="sm"
                        value={r.note}
                        maxLength={400}
                        onChange={(e) => setRef(r.key, { note: e.currentTarget.value })}
                        placeholder="Keep the flame shape"
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {failure && (
          <Callout id="c-failure" tone="error" title="The project didn't start">
            <p>{failure.message}</p>
            {failure.fix && <p>{failure.fix}</p>}
          </Callout>
        )}
      </Form>
    </main>
  );
}

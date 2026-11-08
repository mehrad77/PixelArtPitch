// The one action for a problem the crew can't fix alone: Try again, Fix the key, Use a different model, or Add budget. Each says
// what it causes before it runs (effectOf); adding budget is a small inline form with the new cap.
import { Button, Field } from "@shabboo/kit/react";
import { type FormEvent, useState } from "react";
import { client } from "../lib/client.ts";
import { effectOf, PROBLEM_BUTTON, type Problem, usdPlain } from "../lib/human.ts";
import { navigate } from "../lib/router.tsx";
import type { ProjectState } from "../lib/types.ts";
import { EffectButton } from "./EffectAction.tsx";

/**
 * Settings › Providers, opened on one provider: its section scrolls into view once the page has drawn it, and its key
 * field takes the focus (the person pressed "Fix the key", so the focus moving is theirs)
 */
export function openProvider(provider?: string) {
  navigate("/settings/providers");
  if (!provider) return;
  const until = Date.now() + 4000;
  const look = () => {
    const head = document.getElementById(`prov-${provider}-t`);
    if (!head) {
      if (Date.now() < until) setTimeout(look, 100);
      return;
    }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    head.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    document.getElementById(`prov-${provider}-key`)?.focus({ preventScroll: true });
  };
  requestAnimationFrame(look);
}

export function ProblemButton({
  projectId,
  state,
  problem,
  className,
}: {
  projectId: string;
  state: ProjectState;
  problem: Problem;
  className?: string;
}) {
  if (problem.action === "add_budget") return <AddBudget projectId={projectId} state={state} className={className} />;
  if (problem.action === "fix_key")
    return (
      <EffectButton
        className={className}
        label={PROBLEM_BUTTON.fix_key}
        effect={effectOf({ kind: "fix_key", provider: problem.provider }, state)}
        onRun={() => openProvider(problem.provider)}
      />
    );
  if (problem.action === "change_model")
    return (
      <EffectButton
        className={className}
        label={PROBLEM_BUTTON.change_model}
        effect={effectOf({ kind: "change_model", taskId: problem.taskId }, state)}
        onRun={() => navigate("/settings/roles")}
      />
    );
  return (
    <EffectButton
      className={className}
      label={PROBLEM_BUTTON.retry}
      effect={effectOf({ kind: "retry", taskId: problem.taskId }, state)}
      onRun={() => client.crewRetry(projectId, problem.taskId, state.stage)}
    />
  );
}

function AddBudget({ projectId, state, className }: { projectId: string; state: ProjectState; className?: string }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const fx = effectOf({ kind: "add_budget", amount: add }, state);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!add) {
      setErr("Enter an amount above $0.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await client.patch(projectId, {
        ops: [{ op: "replace", path: "/budget/capUsd", value: state.budget.capUsd + add }],
        reason: `Added ${usdPlain(add)} to the budget`,
        baseRev: state.rev,
      });
      setOpen(false);
    } catch (e2) {
      setErr(`${(e2 as Error).message}. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <span className="effect-action">
        <Button className={className} size="sm" variant="primary" onClick={() => setOpen(true)}>
          {PROBLEM_BUTTON.add_budget}
        </Button>
        <span className="effect-line">The budget is {usdPlain(state.budget.capUsd)}. You pick how much to add.</span>
      </span>
    );
  return (
    <form className="budget-form" onSubmit={submit} aria-busy={busy ? "true" : undefined}>
      <Field
        id={`budget-add-${projectId}`}
        label="Add, in dollars"
        type="number"
        size="sm"
        min={0.5}
        step={0.5}
        value={String(amount)}
        onChange={(e) => setAmount(Number(e.currentTarget.value))}
        hint={fx.text}
        error={err ?? undefined}
      />
      <Button type="submit" size="sm" variant="primary">
        Yes, add {usdPlain(add)}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

// The one button for a problem the crew can't fix alone: Try again, Choose another model, or Add $2.
import { Button } from "@shabboo/kit/react";
import { useState } from "react";
import { client } from "../lib/client.ts";
import { PROBLEM_BUTTON, type Problem } from "../lib/human.ts";
import { navigate } from "../lib/router.tsx";
import type { ProjectState } from "../lib/types.ts";

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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async () => {
    setErr(null);
    if (problem.action === "change_model") return navigate("/settings/setup");
    setBusy(true);
    try {
      if (problem.action === "retry") await client.crewRetry(projectId, problem.taskId, state.stage);
      else
        await client.patch(projectId, {
          ops: [{ op: "replace", path: "/budget/capUsd", value: state.budget.capUsd + 2 }],
          reason: "Added $2 to the budget from the simple view",
          baseRev: state.rev,
        });
    } catch (e) {
      setErr(`${(e as Error).message}. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button className={className} size="sm" variant="primary" onClick={act} aria-busy={busy ? "true" : undefined}>
        {PROBLEM_BUTTON[problem.action]}
      </Button>
      {err && (
        <p className="decision-error" role="status">
          {err}
        </p>
      )}
    </>
  );
}

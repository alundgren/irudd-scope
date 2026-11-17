import { useEffect, useState } from "react";
import type {
  ChatHarnessId,
  ChatProgramChoice,
  ChatProgramModels,
} from "../plugins/canvas/chat/contract.ts";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import { Button } from "./components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";

type Pick = { model?: string; effort?: string; speed?: string };

/**
 * The full choice for a program, keeping earlier values the program still offers and using the
 * model's own defaults for the rest. An empty effort means the program's default.
 */
function choiceFor(
  program: ChatProgramModels,
  previous: ChatProgramChoice | null,
  pick: Pick = {},
): ChatProgramChoice {
  const modelId = pick.model ?? previous?.model;
  const model =
    program.models.find((entry) => entry.id === modelId) ??
    program.models.find((entry) => entry.isDefault) ??
    program.models[0];
  if (!model) return { harness: program.id };
  const effortId = pick.effort ?? previous?.effort;
  const effort =
    pick.effort === ""
      ? undefined
      : (model.efforts.find((entry) => entry.id === effortId) ??
        model.efforts.find((entry) => entry.id === model.defaultEffort));
  const speedId = pick.speed ?? previous?.speed;
  const speed =
    model.speeds.find((entry) => entry.id === speedId) ??
    model.speeds.find((entry) => entry.id === model.defaultSpeed) ??
    model.speeds[0];
  return {
    harness: program.id,
    model: model.id,
    modelName: model.label,
    ...(effort ? { effort: effort.id } : {}),
    ...(speed ? { speed: speed.id, speedName: speed.label } : {}),
  };
}

/** Why a program offers no models, in the words Settings shows. */
const problemOf = (program: ChatProgramModels) =>
  program.installed ? program.problem : `${program.label} isn't installed on this computer.`;

/** Program, model, reasoning and speed for every card chat, from the installed programs. */
export function CardChatSettings({
  active,
  settings,
  busy,
  onSave,
}: {
  active: boolean;
  settings: SettingsView | undefined;
  busy: boolean;
  onSave: (input: SettingsUpdate) => Promise<void>;
}) {
  const enabled = settings?.cardChatEnabled ?? false;
  const [programs, setPrograms] = useState<ChatProgramModels[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const open = active && enabled;
  useEffect(() => {
    if (!open) return;
    let current = true;
    setPrograms(undefined);
    setError("");
    window.scope.cardChatPrograms().then(
      (value) => current && setPrograms(value),
      () => current && setError("Scope couldn't ask the chat programs for their models."),
    );
    return () => {
      current = false;
    };
  }, [open, attempt]);
  if (!enabled) return null;
  if (error)
    return (
      <div className="card-chat-status">
        <p role="alert">{error}</p>
        <Button type="button" variant="secondary" onClick={() => setAttempt(attempt + 1)}>
          Retry
        </Button>
      </div>
    );
  if (!programs)
    return (
      <p className="secondary" role="status">
        Asking Claude Code and Codex for their models…
      </p>
    );

  const saved = settings?.cardChatProgram ?? null;
  const installed = programs.filter((program) => program.installed);
  const program = installed.find((entry) => entry.id === saved?.harness) ?? installed[0];
  const notes = programs.flatMap((entry) => {
    const problem = problemOf(entry);
    return problem && entry !== program ? [problem] : [];
  });
  if (!program)
    return (
      <p className="secondary" role="status">
        Scope can't find Claude Code or Codex on this computer.
      </p>
    );
  const shown = choiceFor(program, saved);
  const model = program.models.find((entry) => entry.id === shown.model);
  const save = (next: ChatProgramChoice) => void onSave({ cardChatProgram: next });
  const pick = (value: Pick) => save(choiceFor(program, saved, value));
  return (
    <>
      <label className="card-chat-choice">
        <span>Program</span>
        <NativeSelect
          aria-label="Program"
          value={program.id}
          disabled={busy}
          onChange={(event) => {
            const next = installed.find((entry) => entry.id === event.target.value)!;
            save(choiceFor(next, saved));
          }}
        >
          {installed.map((entry) => (
            <NativeSelectOption key={entry.id} value={entry.id satisfies ChatHarnessId}>
              {entry.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {program.problem && (
        <p className="secondary" role="status">
          {program.problem}
        </p>
      )}
      {model && (
        <label className="card-chat-choice">
          <span>Model</span>
          <NativeSelect
            aria-label="Model"
            value={model.id}
            disabled={busy}
            onChange={(event) => pick({ model: event.target.value })}
          >
            {program.models.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      {model && model.efforts.length > 0 && (
        <label className="card-chat-choice">
          <span>Reasoning</span>
          <NativeSelect
            aria-label="Reasoning"
            value={shown.effort ?? ""}
            disabled={busy}
            onChange={(event) => pick({ effort: event.target.value })}
          >
            {!model.defaultEffort && <NativeSelectOption value="">Default</NativeSelectOption>}
            {model.efforts.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      {model && model.speeds.length > 1 && (
        <label className="card-chat-choice">
          <span>Speed</span>
          <NativeSelect
            aria-label="Speed"
            value={shown.speed}
            disabled={busy}
            onChange={(event) => pick({ speed: event.target.value })}
          >
            {model.speeds.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      <p className="secondary">
        Changes apply from the next message. A different program starts a new conversation.
      </p>
      {notes.map((note) => (
        <p key={note} className="secondary">
          {note}
        </p>
      ))}
    </>
  );
}

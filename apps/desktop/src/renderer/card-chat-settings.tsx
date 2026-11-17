import { useEffect, useState } from "react";
import {
  defaultModel,
  resolveChoice,
  STANDARD_SPEED,
  type ChatHarnessId,
  type ChatProgramChoice,
  type ChatProgramModels,
} from "../plugins/canvas/chat/contract.ts";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import { Button } from "./components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";

type Pick = { model?: string; effort?: string; speed?: string };

/**
 * The next saved choice after picking from a menu. A new model keeps the reasoning level and
 * speed when it offers them. An empty effort means the program's default.
 */
function picked(program: ChatProgramModels, shown: ChatProgramChoice, pick: Pick) {
  const { effort, ...rest } = shown;
  const model = pick.model ?? shown.model ?? defaultModel(program.models)?.id;
  const nextEffort = pick.effort === "" ? undefined : (pick.effort ?? effort);
  return resolveChoice(program.id, program.models, {
    ...rest,
    ...(model ? { model } : {}),
    ...(nextEffort ? { effort: nextEffort } : {}),
    ...(pick.speed ? { speed: pick.speed } : {}),
  });
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
    let fresh = false;
    setPrograms(undefined);
    setError("");
    const fail = () =>
      current && setError("Scope couldn't ask the chat programs for their models.");
    // The last lists show at once; the programs' newer answers replace them when they come.
    window.scope.cardChatPrograms().then((value) => current && !fresh && setPrograms(value), fail);
    window.scope.cardChatPrograms({ refresh: true }).then((value) => {
      fresh = true;
      if (current) setPrograms(value);
    }, fail);
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
  // Chat sends the same choice: main checks it against these lists with resolveChoice too.
  const shown = resolveChoice(program.id, program.models, saved);
  const model =
    program.models.find((entry) => entry.id === shown.model) ?? defaultModel(program.models);
  const effortShown = shown.effort ?? model?.defaultEffort ?? "";
  const speedShown = shown.speed ?? model?.defaultSpeed ?? STANDARD_SPEED;
  const save = (next: ChatProgramChoice) => void onSave({ cardChatProgram: next });
  const pick = (value: Pick) => save(picked(program, shown, value));
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
            const first = defaultModel(next.models);
            save({
              harness: next.id,
              ...(first ? { model: first.id, modelName: first.label } : {}),
            });
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
            value={effortShown}
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
            value={speedShown}
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

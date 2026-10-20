import type { LibrarianHumanCommand, LibrarianView } from "@irudd-scope/protocol/librarian";

export type Navigation = Omit<
  Extract<LibrarianHumanCommand, { action: "navigate" }>,
  "requestId" | "expectedUiRevision" | "action"
>;

/** Rebuilds the navigation that produced the stored view, for refreshing it after restart. */
export function current(state: LibrarianView): Navigation {
  const common = {
    ...(state.historyRunId ? { historyRunId: state.historyRunId } : {}),
    ...(state.returnChangeId ? { returnChangeId: state.returnChangeId } : {}),
  };
  switch (state.view) {
    case "memory":
      return state.selectedPath
        ? {
            view: "memory",
            path: state.selectedPath,
            trail: [...(state.browse?.trail ?? [])],
            ...common,
          }
        : { view: "browse" };
    case "browse":
      return {
        view: "browse",
        query: state.query,
        directory: state.directory,
        offset: state.browse?.offset ?? state.offset,
      };
    case "decision":
      return {
        view: "decision",
        ...(state.selectedChangeId ? { changeId: state.selectedChangeId } : {}),
      };
    case "overview":
      return {
        view: "overview",
        ...common,
        ...(state.selectedChangeId
          ? { changeId: state.selectedChangeId }
          : { offset: state.offset }),
      };
    default:
      return { view: state.view, ...common };
  }
}

const key = "scope-plan-editor-id";

function remembered() {
  try {
    return sessionStorage.getItem(key) ?? createId();
  } catch {
    return createId();
  }
}

function remember(id: string) {
  try {
    sessionStorage.setItem(key, id);
  } catch {
    /* Without session storage, a tab still has an independent editor identity. */
  }
}

function claim(id: string, wait = false) {
  return new Promise<boolean>((resolve) => {
    void navigator.locks
      .request(`scope-plan-editor:${id}`, { ifAvailable: !wait }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        await new Promise<void>((release) =>
          window.addEventListener("pagehide", () => release(), { once: true }),
        );
      })
      .catch(() => resolve(true));
  });
}

export async function editorIdentity() {
  let id = remembered();
  // Duplicating a browser tab copies sessionStorage; its draft must stay independent.
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const returning = navigation?.type === "reload" || navigation?.type === "back_forward";
  if (navigator.locks && !(await claim(id, returning))) {
    id = createId();
    await claim(id);
  }
  remember(id);
  return id;
}
import { createId } from "./identity.ts";

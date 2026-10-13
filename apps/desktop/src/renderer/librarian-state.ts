import { useEffect, useState } from "react";
import type { LibrarianView } from "@irudd-scope/protocol/librarian";
export function useLibrarian() {
  const [state, setState] = useState<LibrarianView>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    let observed = false;
    const unsubscribe = window.scope.onLibrarianChange((next) => {
      observed = true;
      if (current) {
        setState(next);
        setError("");
      }
    });
    void window.scope
      .librarianRead()
      .then((next) => {
        if (current && !observed) setState(next);
      })
      .catch(() => {
        if (current && !observed) setError("Could not load Librarian. Reopen it to retry.");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return { state, setState, error, setError };
}

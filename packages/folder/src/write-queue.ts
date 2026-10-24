// One queue includes overlapping roots, path aliases, legacy copies and versioned operations.
let pending = Promise.resolve();
export function serializeFolderWrites<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}

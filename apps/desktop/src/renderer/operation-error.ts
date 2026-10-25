export function operationError(
  error: unknown,
  fallback = "Could not complete this action. Retry.",
): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : fallback;
}

export function primaryShortcut(key: string) {
  return window.scope.platform === "darwin" ? `⌘${key.replace("Shift+", "⇧")}` : `Ctrl+${key}`;
}

export function hasPrimaryModifier(event: KeyboardEvent) {
  if (event.altKey) return false;
  return window.scope.platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

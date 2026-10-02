import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./components/ui/button.tsx";

const settingsSections = [
  {
    id: "appearance",
    title: "Appearance",
    description: "Color scheme",
    terms: "theme system light dark colors",
  },
  {
    id: "model",
    title: "Diagram generation",
    description: "Enable diagram generation and view its model",
    terms: "openrouter gemini",
  },
  {
    id: "voice",
    title: "Voice generation",
    description: "Let coding agents generate narration audio",
    terms: "speech tts text audio gemini aoede leda kore conversational podcast openrouter",
  },
  {
    id: "credentials",
    title: "OpenRouter",
    description: "Save, replace, or remove the shared API key",
    terms: "provider credentials key keychain gemini diagram voice speech tts",
  },
  {
    id: "remotes",
    title: "Remotes",
    description: "Pair remotes and manage connections and updates",
    terms: "hub pairing tailnet tailscale disconnect cli skill version retry",
  },
  {
    id: "transfers",
    title: "Other Scopes",
    description: "Pair another Scope to send and import tabs",
    terms: "tab transfer devices pairing sharing qr code invitation",
  },
  {
    id: "updates",
    title: "App updates",
    description: "Check for updates and restart",
    terms: "install installation version main commit build",
  },
  {
    id: "tools",
    title: "Agent tools",
    description: "Install the CLI and publishing skill",
    terms: "installation command global codex claude npx",
  },
  {
    id: "signing",
    title: "Signing certificate",
    description: "Reduce Keychain permission prompts",
    terms: "permission nag identity name fingerprint connect certificate cert local sign",
  },
] as const;

export function matchingSettings(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/);
  return settingsSections.filter((section) =>
    words.every((word) =>
      `${section.title} ${section.description} ${section.terms}`.toLowerCase().includes(word),
    ),
  );
}

export function SettingsSection({
  id,
  query,
  children,
}: {
  id: (typeof settingsSections)[number]["id"];
  query: string;
  children: ReactNode | ((active: boolean) => ReactNode);
}) {
  const labelId = useId();
  const [disclosure, setDisclosure] = useState({ query, expanded: Boolean(query.trim()) });
  if (disclosure.query !== query) {
    setDisclosure({ query, expanded: Boolean(query.trim()) });
  }
  const section = settingsSections.find((entry) => entry.id === id)!;
  const visible = matchingSettings(query).some((entry) => entry.id === id);
  return (
    <section className="settings-section" hidden={!visible}>
      <h2>
        <Button
          type="button"
          variant="ghost"
          className="settings-section-toggle"
          aria-describedby={`${labelId}-description`}
          aria-expanded={disclosure.expanded}
          aria-controls={`${labelId}-content`}
          onClick={() => setDisclosure({ query, expanded: !disclosure.expanded })}
        >
          <span className="settings-section-heading">
            <span>{section.title}</span>
            <span id={`${labelId}-description`} className="secondary" aria-hidden="true">
              {section.description}
            </span>
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </h2>
      <div
        id={`${labelId}-content`}
        className="settings-section-content settings-form"
        hidden={!disclosure.expanded}
      >
        {typeof children === "function" ? children(visible && disclosure.expanded) : children}
      </div>
    </section>
  );
}

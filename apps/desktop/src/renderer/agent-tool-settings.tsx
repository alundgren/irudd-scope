import type { AgentToolStatus } from "../installation-contract.ts";
import { Button } from "./components/ui/button.tsx";
import { SettingsSection } from "./settings-section.tsx";

export function AgentToolSettings({
  query,
  tools,
  disabled,
  run,
}: {
  query: string;
  tools: AgentToolStatus | undefined;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const { available, busy, cliInstalled, cliPath, skillInstalled, message, error } = tools ?? {};
  return (
    <SettingsSection id="tools" query={query}>
      {!available && <p className="secondary">Use the installed Mac app to install agent tools.</p>}
      <div className="installation-tool">
        <div>
          <h3>Scope CLI</h3>
          <p className="secondary">
            Publish artifacts with <code>irudd-scope</code>. The CLI updates with the app.
          </p>
        </div>
        <div className="installation-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => run(() => window.scope.installCli())}
          >
            {busy === "cli" ? "Working…" : cliInstalled ? "Repair CLI" : "Install CLI"}
          </Button>
          {cliInstalled && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => run(() => window.scope.removeCli())}
            >
              Remove CLI
            </Button>
          )}
        </div>
        {cliInstalled && (
          <p className="secondary installation-path">
            Installed at <code>{cliPath}</code>
          </p>
        )}
      </div>
      <div className="installation-tool">
        <div>
          <h3>Scope skill</h3>
          <p className="secondary">
            Instructions for Codex and Claude Code update with the app. Refresh or start a new agent
            session after an update.
          </p>
        </div>
        <div className="installation-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => run(() => window.scope.installSkill())}
          >
            {busy === "skill" ? "Working…" : skillInstalled ? "Repair skill" : "Install skill"}
          </Button>
          {skillInstalled && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => run(() => window.scope.removeSkill())}
            >
              Remove skill
            </Button>
          )}
        </div>
        {skillInstalled && <p className="secondary">Installed globally. Updates with Scope.</p>}
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <details className="installation-output" open>
          <summary role="alert">Installation failed. Try again.</summary>
          <pre>{error}</pre>
        </details>
      )}
    </SettingsSection>
  );
}

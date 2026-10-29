import type { ReactNode } from "react";
import { Check, CircleHelp, Link, X } from "lucide-react";
import type {
  HarnessReport,
  HarnessSignIn,
  SharedSkillsReport,
} from "@irudd-scope/protocol/harnesses";

const UNITS = ["KB", "MB", "GB", "TB"];
/** Decimal units like a file manager: one decimal below 100, none from 100 up, so 405 MB and 11.6 GB. */
export function formatSize(size: number) {
  if (size < 1000) return count(size, "byte");
  for (const [index, unit] of UNITS.entries()) {
    const value = size / 1000 ** (index + 1);
    const text = value < 99.95 ? value.toFixed(1) : value.toFixed(0);
    if (Number(text) < 1000 || index === UNITS.length - 1) return `${text} ${unit}`;
  }
  return count(size, "byte");
}
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const SIGN_IN = {
  "signed-in": { icon: Check, words: "Signed in" },
  "not-signed-in": { icon: X, words: "Not signed in" },
  unknown: { icon: CircleHelp, words: "Sign-in unknown" },
} as const;
const METHODS: Record<string, string> = {
  chatgpt: "ChatGPT",
  apikey: "an API key",
  api_key: "an API key",
  oauth: "OAuth",
};

export function SignIn({ signIn, method = false }: { signIn: HarnessSignIn; method?: boolean }) {
  const { icon: Icon, words } = SIGN_IN[signIn.state];
  return (
    <span className="harnesses-sign-in">
      <Icon aria-hidden="true" />
      {words}
      {method && signIn.method && ` with ${METHODS[signIn.method] ?? signIn.method}`}
    </span>
  );
}

function sizeText(report: HarnessReport, counting: boolean) {
  if (!report.size) return null;
  if (report.size.state === "done") return formatSize(report.size.bytes);
  return counting ? "counting…" : "size unknown";
}

/**
 * Codex documents ~/.agents/skills as its user skill folder, so its cell points to the Shared
 * skills row. Scope says nothing about the folder for other harnesses.
 */
export function HarnessCell({
  report,
  counting,
  shared,
}: {
  report: HarnessReport;
  counting: boolean;
  shared: boolean;
}) {
  const own = report.skills.filter((skill) => skill.location === "own").length;
  const skills = count(own, "skill");
  return (
    <>
      <span className="harnesses-cell-line">
        <SignIn signIn={report.signIn} />
        <span aria-hidden="true">·</span>
        <code>{report.version ?? "version unknown"}</code>
      </span>
      <span className="harnesses-cell-detail">
        {[
          sizeText(report, counting),
          report.id === "codex" && shared ? `${skills} + shared skills below` : skills,
          `${report.mcpServers.length} MCP`,
          ...report.instructions.map((file) => fileName(file.path)),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </>
  );
}

export function SharedCell({ report }: { report: SharedSkillsReport }) {
  return (
    <span className="harnesses-cell-line">
      {report.linked ? "Linked folder" : count(report.skills.length, "skill")}
    </span>
  );
}

function Names({
  items,
  empty = "None",
}: {
  items: { name: string; marks: (string | false)[] }[];
  empty?: string;
}) {
  if (!items.length) return <p className="harnesses-muted">{empty}</p>;
  return (
    <ul className="harnesses-names">
      {items.map((item, index) => (
        <li key={`${item.name}-${index}`}>
          <code>{item.name}</code>
          {item.marks.filter(Boolean).map((mark) => (
            <span key={mark as string} className="harnesses-mark">
              {mark}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={wide ? "harnesses-wide" : undefined}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

type Skill = { name: string; linked: boolean };

/** The heading counts linked skills too, for example "Own skills · 14 · 10 linked". */
function skillsTitle(label: string, skills: readonly Skill[]) {
  const linked = skills.filter((skill) => skill.linked).length;
  return [label, String(skills.length), linked ? `${linked} linked` : ""]
    .filter(Boolean)
    .join(" · ");
}

function SkillChips({ skills }: { skills: readonly Skill[] }) {
  if (!skills.length) return <p className="harnesses-muted">None</p>;
  return (
    <ul className="harnesses-chips">
      {skills.map((skill, index) => (
        <li key={`${skill.name}-${index}`}>
          <code>{skill.name}</code>
          {skill.linked && (
            <Link role="img" aria-label="linked" className="harnesses-chip-link">
              <title>Linked. Scope does not read its target.</title>
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

export function HarnessDetails({ report, counting }: { report: HarnessReport; counting: boolean }) {
  const own = report.skills.filter((skill) => skill.location === "own");
  const bundled = report.skills.filter((skill) => skill.location === "bundled");
  return (
    <>
      <Section title="Version">
        <p>
          <code>{report.version ?? "Unknown"}</code>
        </p>
      </Section>
      <Section title="Sign-in">
        <p>
          <SignIn signIn={report.signIn} method />
        </p>
        <p className="harnesses-muted">Scope checks that a sign-in exists and never reads it.</p>
      </Section>
      <Section title="Main folder">
        <p>
          <code>{report.home}</code>
        </p>
        {report.size?.state === "done" ? (
          <>
            <p>
              {formatSize(report.size.bytes)} · {count(report.size.files, "file")}
            </p>
            {report.size.parts.length > 0 && (
              <ul className="harnesses-parts" aria-label="Largest parts">
                {report.size.parts.map((part) => (
                  <li key={part.name}>
                    <code>{part.name}</code>
                    <span className="harnesses-muted">{formatSize(part.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="harnesses-muted">
            {counting ? "Counting…" : "Size unknown. Rescan to count it."}
          </p>
        )}
      </Section>
      <Section title="Instructions">
        {report.instructions.length ? (
          <ul className="harnesses-files">
            {report.instructions.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                <span className="harnesses-muted">
                  {file.linked
                    ? "Linked file. Scope does not read it."
                    : [
                        count(file.lines ?? 0, "line"),
                        formatSize(file.bytes ?? 0),
                        `fingerprint ${file.sha256?.slice(0, 8)}`,
                      ].join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="harnesses-muted">No global instruction files</p>
        )}
      </Section>
      <Section title={`MCP servers · ${report.mcpServers.length}`}>
        <Names
          items={report.mcpServers.map((server) => ({
            name: server.name,
            marks: [server.transport, server.location === "bundled" && "bundled"],
          }))}
        />
      </Section>
      <Section title={`Agents · ${report.agents.length}`}>
        <Names
          items={report.agents.map((agent) => ({
            name: agent.name,
            marks: [
              agent.kind !== "agent" && agent.kind,
              agent.location === "bundled" && "bundled",
              agent.linked && "linked",
            ],
          }))}
        />
      </Section>
      <Section title={skillsTitle("Own skills", own)} wide>
        <SkillChips skills={own} />
      </Section>
      {bundled.length > 0 && (
        <Section title={skillsTitle("Bundled skills", bundled)} wide>
          <SkillChips skills={bundled} />
        </Section>
      )}
      {report.unreadable.length > 0 && (
        <Section title="Could not read" wide>
          <Names items={report.unreadable.map((path) => ({ name: path, marks: [] }))} />
        </Section>
      )}
      {report.truncated && (
        <p className="harnesses-wide harnesses-muted">
          Some skills, agents or MCP servers are left out because the lists are too long.
        </p>
      )}
    </>
  );
}

export function SharedDetails({ report }: { report: SharedSkillsReport }) {
  return (
    <>
      <Section title="Folder" wide>
        <p>
          <code>{report.home}</code>
        </p>
        <p className="harnesses-muted">
          {report.linked
            ? "This folder is a link. Scope lists nothing inside it."
            : "Scope does not say which harnesses load this folder."}
        </p>
      </Section>
      {!report.linked && (
        <Section title={skillsTitle("Skills", report.skills)} wide>
          <SkillChips skills={report.skills} />
        </Section>
      )}
      {report.truncated && (
        <p className="harnesses-wide harnesses-muted">
          Some skills are left out because the list is too long.
        </p>
      )}
    </>
  );
}

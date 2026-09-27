export type SigningCertificate = {
  name: string;
  fingerprint: string;
};

export type UpdateStatus = {
  phase: "unmanaged" | "idle" | "checking" | "building" | "ready" | "error";
  message: string;
  currentCommit?: string;
  nextCommit?: string;
  output?: string;
  operation?: "update" | "signing";
  currentSigningIdentity?: string;
  nextSigningCertificate?: SigningCertificate;
};

export type AgentToolStatus = {
  available: boolean;
  cliInstalled: boolean;
  cliPath: string;
  skillInstalled: boolean;
  busy: "cli" | "skill" | null;
  message: string;
  error?: string;
};

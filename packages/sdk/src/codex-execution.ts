export const CODEX_APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;

export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

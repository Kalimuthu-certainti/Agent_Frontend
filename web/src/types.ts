/** Mirrors the RunLogReader contract exactly. Nullable means "not recorded". */

export type Verdict = 'pass' | 'approved' | 'bounced' | 'blocked' | 'pending' | 'escalated';
export type Band = 'nominal' | 'warning' | 'handover' | null;

export interface Summary {
  steps: number;
  cost_usd: number | null; cost_recorded: number;
  tokens_in: number | null; tokens_in_recorded: number;
  tokens_out: number | null; tokens_out_recorded: number;
  tokens_total: number | null; tokens_total_recorded: number;
}

export interface AgentState {
  agent_name: string;
  run_id: string;
  claude_session_id: string | null;
  model: string | null;
  ticket_key: string | null;
  phase: string | null;
  step: string | null;
  context_pct: number | null;
  context_band: Band;
  last_step_at: string | null;
  minutes_since_step: number | null;
  source: 'live' | 'backfill';
  steps_logged: number;
  today: Summary;
}

export interface GateState {
  gate: string; verdict: Verdict; recorded: boolean;
  ts: string | null; by: string | null; note: string | null;
  source?: 'live' | 'backfill';
}

export interface TicketGates {
  ticket_key: string;
  gates: GateState[];
  blocked: boolean;
  blocking_gates: string[];
  ready_to_merge: boolean;
  pr_url: string | null;
  ci_state: string | null;
  solution_commit: string | null;
  steps: number;
  last_activity: string | null;
}

export interface Step {
  ts: string; run_id: string; agent_name: string;
  claude_session_id: string | null; model: string | null;
  ticket_key: string | null; phase: string | null; step: string | null;
  tokens_in: number | null; tokens_out: number | null;
  cost_usd: number | null; context_pct: number | null;
  gate: string | null; verdict: Verdict | null; note: string | null;
  pr_url: string | null; ci_state: string | null; solution_commit: string | null;
  source: 'live' | 'backfill';
}

export interface Bucket extends Summary { key: string }

export interface Usage {
  series: Bucket[]; byTicket: Bucket[]; byAgent: Bucket[]; byModel: Bucket[];
  totals: Summary; window_days: number;
}

export interface AgentsPayload {
  agents: AgentState[]; log_exists: boolean; malformed_lines: number; log_path: string;
}
export interface RunsPayload { rows: Step[]; total: number; truncated: boolean; malformed: number; log_exists: boolean }
export interface GatesPayload { tickets: TicketGates[]; gate_order: string[] }

export interface ApprovalRecord {
  ts: string; request_id: string; ticket_key: string | null; gate: string | null;
  decision: 'approved' | 'bounced'; reason: string | null; actor: string; channel: 'ui' | 'email';
}
export interface ApprovalItem {
  request_id: string; ticket_key: string; gate: string; verdict: Verdict;
  raised_at: string | null; raised_by: string | null; note: string | null;
  pr_url: string | null; ci_state: string | null; solution_commit: string | null;
  blocked: boolean; blocking_gates: string[]; ready_to_merge: boolean;
  decision: ApprovalRecord | null;
}
export interface ApprovalsPayload { items: ApprovalItem[]; decided: ApprovalRecord[]; gate_order: string[] }
export interface Config {
  log_path: string; jira_configured: boolean; jira_project: string | null;
  mail_configured: boolean; reader: string;
}

/* ---------- configuration ----------
 * The SMTP password is never sent to the browser. `password_set` is all the UI
 * is told about it, and all it needs to render honestly. */

export type MailSecurity = 'tls' | 'starttls' | 'none';
export type Role = 'owner' | 'approver' | 'viewer';
export type NotifyEvent = 'approval.recorded' | 'requirement.created';

export interface MailConfig {
  host: string; port: number; security: MailSecurity;
  username: string | null; password_set: boolean;
  from_name: string | null; from_email: string; reply_to: string | null;
  updated_at: string;
}

export interface ConfigGroup {
  id: string; name: string; team: string; description: string | null;
  notify_events: NotifyEvent[]; created_at: string; updated_at: string;
}

export interface RegistryUser {
  id: string; name: string; email: string; role: Role;
  group_id: string | null; notify: boolean; created_at: string; updated_at: string;
}

export interface SettingsPayload {
  mail: MailConfig | null;
  mail_configured: boolean;
  groups: ConfigGroup[];
  users: RegistryUser[];
  security_options: MailSecurity[];
  roles: Role[];
  events: NotifyEvent[];
  settings_path: string;
}

export interface MailTestResult {
  sent: boolean; to: string[]; message_id: string; server_reply: string;
  ms: number; transcript: string[];
}

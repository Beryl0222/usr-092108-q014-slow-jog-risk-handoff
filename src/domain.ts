/** 超慢跑风险接力使用的领域事件信封与主要载荷类型。 */

export type AggregateType =
  | "participant_plan"
  | "activity_session"
  | "risk_observation"
  | "clinical_handoff";

export type EventType =
  | "PROFILE_REGISTERED"
  | "PHYSICIAN_SCOPE_RECORDED"
  | "MOVEMENT_ASSESSED"
  | "PLAN_APPROVED"
  | "SESSION_RECORDED"
  | "ATTENDANCE_RECORDED"
  | "LOAD_RECORDED"
  | "LOAD_CONFIRMED"
  | "FEEDBACK_RECORDED"
  | "RISK_FLAGGED"
  | "DEVICE_READING_RESOLVED"
  | "TRIAGE_DECIDED"
  | "ACTIVITY_PAUSED"
  | "HANDOFF_RECORDED"
  | "REVIEW_SCHEDULED"
  | "REVIEW_COMPLETED";

export interface DomainEvent<P = Record<string, unknown>> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 业务更正指向的被更正事件；更正不原地改写历史。 */
  supersedes?: string;
  payload?: P;
}

// ---- 三种可解释状态 ----

export type TriageStatus = "CONTINUE" | "REDUCE_AND_OBSERVE" | "PAUSE_AND_REFER";

export interface TriageReason {
  rule_id: string;
  summary: string;
}

export interface IntensityCap {
  max_duration_min: number;
  max_heart_rate: number;
}

export interface TriageDecisionPayload {
  participant_id: string;
  session_id: string;
  status: TriageStatus;
  reasons: TriageReason[];
  advisories: TriageReason[];
  constraints: IntensityCap | null;
  plan_version: number | null;
  rule_set_version: number;
}

// ---- 主要载荷 ----

export type BaselineActivity = "sedentary" | "light" | "regular";

export interface ProfilePayload {
  participant_id: string;
  display_name: string | null;
  goals: string[];
  baseline_activity: BaselineActivity;
  self_reported_risks: string[];
  recent_acute_injury: { description: string; occurred_on: string } | null;
}

export interface PhysicianScopePayload {
  participant_id: string;
  max_heart_rate: number;
  max_duration_min: number;
  restrictions: string[];
  valid_until: string;
  issued_by: string;
  note: string | null;
}

export interface PlanPayload {
  participant_id: string;
  plan_version: number;
  group: string;
  level: string | null;
  target_duration_min: number;
  target_heart_rate: number;
  effective_from_session_seq: number;
  approved_by: string;
  note: string | null;
}

export interface Venue {
  temperature_c: number;
  humidity_pct: number;
}

export interface SessionPayload {
  session_id: string;
  seq: number;
  site_id: string;
  scheduled_at: string;
  venue: Venue;
  note: string | null;
}

export type LoadSource = "wearable" | "manual_checkin" | "self_report";

export interface LoadMetrics {
  duration_min: number;
  distance_km?: number;
  avg_heart_rate?: number;
  steps?: number;
}

export interface LoadPayload {
  session_id: string;
  participant_id: string;
  source: LoadSource;
  record_id: string;
  metrics: LoadMetrics;
  absent_conflict: boolean;
}

export type FlagKind =
  | "chest_pain"
  | "dizziness"
  | "acute_injury"
  | "palpitations"
  | "abnormal_device_value"
  | "other";

export interface HandoffPayload {
  participant_id: string;
  handoff_id: string;
  session_id: string;
  kind: FlagKind;
  handled_by: string;
  handoff_to: string;
  preempted_session: boolean;
  note: string | null;
}

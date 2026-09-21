/** 超慢跑风险接力使用的领域事件信封。 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: TPayload;
}

export type EventType =
  | "PROFILE_REGISTERED"
  | "MEDICAL_SCOPE_RECORDED"
  | "MOVEMENT_ASSESSED"
  | "PLAN_APPROVED"
  | "RULE_REGISTERED"
  | "SESSION_RECORDED"
  | "ATTENDANCE_RECORDED"
  | "ABSENCE_RECORDED"
  | "LOAD_RECORDED"
  | "DEVICE_ANOMALY_FLAGGED"
  | "DEVICE_VALUE_CONFIRMED"
  | "RISK_FLAGGED"
  | "HANDOFF_RECORDED"
  | "ACTIVITY_PAUSED"
  | "REVIEW_SCHEDULED"
  | "REVIEW_COMPLETED";

export type AggregateType =
  | "participant_profile"
  | "participant_plan"
  | "activity_session"
  | "risk_observation"
  | "clinical_handoff"
  | "safety_rule"
  | "pause_decision"
  | "review_schedule";

/** 参与者可解释状态：继续 / 降量观察 / 暂停并交接专业人员。 */
export type ParticipantState = "CONTINUE" | "REDUCE_OBSERVE" | "PAUSE_HANDOFF";

/** 审核规则允许的建议动作；规则不诊断疾病，也不修改治疗。 */
export type RuleAction = "CONSULT" | "REDUCE" | "STOP";

export type RecordSource = "wearable" | "manual_checkin" | "self_report";

export type SignalType =
  | "chest_pain"
  | "dizziness"
  | "acute_injury"
  | "palpitation"
  | "shortness_of_breath"
  | "joint_pain"
  | "unusual_fatigue"
  | "device_abnormal";

export type LoadStatus = "CONFIRMED" | "PENDING_CONFIRMATION" | "REJECTED" | "SUPERSEDED";

export type ReviewOutcome = "resume" | "resume_reduced" | "continue_pause";

export interface ParticipantGoal {
  text: string;
  target_sessions_per_week?: number;
}

export interface BaselineActivity {
  level: number;
  daily_steps?: number;
}

export interface SelfReportedRisk {
  kind: string;
  note?: string;
}

/** 医生给出的参与范围：仅约束参与边界，不构成诊断或治疗变更。 */
export interface MedicalScope {
  issued_by: string;
  max_sessions_per_week?: number;
  max_heart_rate?: number;
  max_minutes_per_session?: number;
  restrictions?: string[];
  valid_until?: string;
}

export interface MovementAssessment {
  assessor: string;
  result: string;
  cautions: string[];
  assessed_at?: string;
}

/** 分组计划版本：自下一场生效，既往场次绑定的版本不回写。 */
export interface PlanVersion {
  version: number;
  group: string;
  weekly_sessions: number | null;
  target_load: number;
  decided_by: string;
  note: string;
  approved_at: string;
  effective_from: string;
}

export interface LoadRecord {
  record_id: string;
  session_id: string;
  participant_id: string;
  source: RecordSource;
  duration_min: number | null;
  avg_hr: number | null;
  distance_km: number | null;
  rpe: number | null;
  recorded_at: string;
  plan_version: number | null;
  status: LoadStatus;
  anomalies: string[];
  conflict: boolean;
  supersedes: string | null;
}

export interface PauseDecision {
  pause_id: string;
  participant_id: string;
  decided_by: string;
  reason: string;
  signal_id: string | null;
  decided_at: string;
  lifted_by: string | null;
}

export interface ReviewAppointment {
  review_id: string;
  participant_id: string;
  reviewer: string;
  due_at: string;
  note: string;
  status: "scheduled" | "completed";
  scheduled_at: string;
  completed_at: string | null;
  outcome: ReviewOutcome | null;
}

export interface HandoffRecord {
  handoff_id: string;
  participant_id: string;
  session_id: string | null;
  signal: SignalType;
  note: string;
  received_by: string;
  handed_at: string;
}

export interface AssessmentReason {
  code: string;
  detail: string;
}

export interface RuleAdvice {
  rule_id: string;
  action: RuleAction;
  description: string;
}

export interface Assessment {
  participant_id: string;
  state: ParticipantState;
  reasons: AssessmentReason[];
  advice: RuleAdvice[];
  assessed_at: string;
}

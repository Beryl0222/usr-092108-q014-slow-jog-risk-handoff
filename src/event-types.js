/**
 * 超慢跑风险接力的领域常量。
 * 事件类型、聚合类型与 contracts/domain.schema.json 保持一致（由契约测试守护）。
 */

export const AGGREGATE_TYPES = Object.freeze([
  "participant_plan",
  "activity_session",
  "risk_observation",
  "clinical_handoff",
]);

export const EVENT_TYPES = Object.freeze([
  // participant_plan：本人目标、基础活动水平、自报风险、医生参与范围、动作评估、分组计划
  "PROFILE_REGISTERED",
  "PHYSICIAN_SCOPE_RECORDED",
  "MOVEMENT_ASSESSED",
  "PLAN_APPROVED",
  // activity_session：场次与场地温湿度、出席、每次负荷、主观感受
  "SESSION_RECORDED",
  "ATTENDANCE_RECORDED",
  "LOAD_RECORDED",
  "LOAD_CONFIRMED",
  "FEEDBACK_RECORDED",
  // risk_observation：异常信号、设备读数确认、三态判定
  "RISK_FLAGGED",
  "DEVICE_READING_RESOLVED",
  "TRIAGE_DECIDED",
  // clinical_handoff：暂停决定、人工交接、复评安排与完成
  "ACTIVITY_PAUSED",
  "HANDOFF_RECORDED",
  "REVIEW_SCHEDULED",
  "REVIEW_COMPLETED",
]);

/** 每种事件归属的聚合，版本号在该聚合内连续递增。 */
export const EVENT_AGGREGATE = Object.freeze({
  PROFILE_REGISTERED: "participant_plan",
  PHYSICIAN_SCOPE_RECORDED: "participant_plan",
  MOVEMENT_ASSESSED: "participant_plan",
  PLAN_APPROVED: "participant_plan",
  SESSION_RECORDED: "activity_session",
  ATTENDANCE_RECORDED: "activity_session",
  LOAD_RECORDED: "activity_session",
  LOAD_CONFIRMED: "activity_session",
  FEEDBACK_RECORDED: "activity_session",
  RISK_FLAGGED: "risk_observation",
  DEVICE_READING_RESOLVED: "risk_observation",
  TRIAGE_DECIDED: "risk_observation",
  ACTIVITY_PAUSED: "clinical_handoff",
  HANDOFF_RECORDED: "clinical_handoff",
  REVIEW_SCHEDULED: "clinical_handoff",
  REVIEW_COMPLETED: "clinical_handoff",
});

/** 负荷记录来源：穿戴设备、人工签到、本人补录。 */
export const LOAD_SOURCES = Object.freeze(["wearable", "manual_checkin", "self_report"]);

/** 多源一致时采用的可信度优先级（靠前者优先）。 */
export const LOAD_SOURCE_PRIORITY = Object.freeze(["wearable", "manual_checkin", "self_report"]);

/** 红旗信号：出现即需要人工处置抢占普通课程。 */
export const RED_FLAG_KINDS = Object.freeze(["chest_pain", "dizziness", "acute_injury"]);

/** 全部异常信号种类。 */
export const FLAG_KINDS = Object.freeze([
  ...RED_FLAG_KINDS,
  "palpitations",
  "abnormal_device_value",
  "other",
]);

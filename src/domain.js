/** 领域常量：可解释状态、建议动作、异常信号与记录来源。 */

/** 参与者可解释状态：可以按当前计划继续 / 先降低负荷观察 / 暂停并交给专业人员。 */
export const PARTICIPANT_STATES = Object.freeze({
  CONTINUE: "CONTINUE",
  REDUCE_OBSERVE: "REDUCE_OBSERVE",
  PAUSE_HANDOFF: "PAUSE_HANDOFF",
});

/**
 * 经审核的规则只允许给出的建议动作：提示咨询、建议降量、建议停止。
 * 规则不诊断疾病，也不修改治疗——动作集合在结构上就排除了这两类输出。
 */
export const RULE_ACTIONS = Object.freeze({
  CONSULT: "CONSULT",
  REDUCE: "REDUCE",
  STOP: "STOP",
});

/** 红旗信号：胸痛、眩晕、急性损伤。出现即由人工处置抢占普通课程并记录交接。 */
export const RED_FLAG_SIGNALS = Object.freeze(["chest_pain", "dizziness", "acute_injury"]);

/** 全部异常信号类型（红旗之外的信号进入评估依据，但不触发抢占）。 */
export const SIGNAL_TYPES = Object.freeze([
  "chest_pain",
  "dizziness",
  "acute_injury",
  "palpitation",
  "shortness_of_breath",
  "joint_pain",
  "unusual_fatigue",
  "device_abnormal",
]);

/** 运动记录来源：穿戴设备、人工签到、本人补录。 */
export const RECORD_SOURCES = Object.freeze(["wearable", "manual_checkin", "self_report"]);

/** 多源记录互相矛盾时的采信优先级：人工签到 > 穿戴设备 > 本人补录。 */
export const SOURCE_PRECEDENCE = Object.freeze(["manual_checkin", "wearable", "self_report"]);

/** 复评结论。 */
export const REVIEW_OUTCOMES = Object.freeze(["resume", "resume_reduced", "continue_pause"]);

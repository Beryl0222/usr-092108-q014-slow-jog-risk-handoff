import { RULE_ACTIONS } from "./domain.js";

const OPS = Object.freeze({
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
});

/** 规则可引用的事实白名单，避免规则越权读取与评估无关的数据。 */
export const RULE_FACTS = Object.freeze([
  "temperature_c",
  "humidity_pct",
  "last_rpe",
  "last_avg_hr",
  "sessions_last_7d",
  "load_minutes_last_7d",
  "medical_max_sessions_per_week",
  "medical_max_heart_rate",
  "pending_device_anomalies",
  "unhandled_red_flags",
  "self_reported_risk_count",
  "movement_caution_count",
  "baseline_activity_level",
]);

/**
 * 创建一条经审核的规则。
 * 规则只能提示咨询、降量或停止；不诊断疾病，也不修改治疗。
 * 缺少审核信息（reviewed_by / reviewed_at）的规则不允许启用。
 */
export function createRule({ rule_id, description, condition, action, reviewed_by, reviewed_at }) {
  if (!rule_id) throw new Error("规则缺少 rule_id");
  if (!Object.values(RULE_ACTIONS).includes(action)) {
    throw new Error("规则动作仅限咨询、降量或停止建议；规则不诊断疾病，也不修改治疗");
  }
  if (!reviewed_by || !reviewed_at) {
    throw new Error("规则必须经审核（reviewed_by / reviewed_at）后才能启用");
  }
  if (!condition || !RULE_FACTS.includes(condition.fact) || !(condition?.op in OPS)) {
    throw new Error(`规则条件必须引用受支持的事实字段：${RULE_FACTS.join("、")}`);
  }
  return Object.freeze({
    rule_id,
    description: description ?? "",
    condition: Object.freeze({ ...condition }),
    action,
    reviewed_by,
    reviewed_at,
  });
}

/** 对给定事实求值规则条件；事实缺失时规则不触发。 */
export function evaluateCondition(condition, facts) {
  const actual = facts[condition.fact];
  if (actual === undefined || actual === null) return false;
  return OPS[condition.op](actual, condition.value);
}

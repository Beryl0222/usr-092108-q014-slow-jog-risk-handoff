/**
 * 经审核的判定规则与三态判定引擎。
 *
 * 设计约束（对应业务红线）：
 * - 规则动作只有三种：提示咨询（ADVISE_CONSULT）、降量（REDUCE_LOAD）、停止（STOP_ACTIVITY）。
 *   规则不诊断疾病，也不修改治疗；任何超出该动作集合的规则在加载时即被拒绝。
 * - 每条规则都必须在 data/rules.approved.json 中具有审核记录，且动作一致，否则拒绝启用。
 * - 判定输出三种可解释状态之一，并附上命中的规则理由，供参与者与工作人员理解依据。
 */

/** 三种可解释状态。 */
export const TRIAGE_STATUS = Object.freeze({
  CONTINUE: "CONTINUE",
  REDUCE_AND_OBSERVE: "REDUCE_AND_OBSERVE",
  PAUSE_AND_REFER: "PAUSE_AND_REFER",
});

export const TRIAGE_STATUS_LABEL = Object.freeze({
  CONTINUE: "可以按当前计划继续",
  REDUCE_AND_OBSERVE: "先降低负荷观察",
  PAUSE_AND_REFER: "暂停并交给专业人员",
});

export const RULE_ACTIONS = Object.freeze(["ADVISE_CONSULT", "REDUCE_LOAD", "STOP_ACTIVITY"]);

/**
 * 规则实现。summary 为中文可解释理由，可以是字符串或 (facts, thresholds) => string。
 * applies(facts, thresholds) 返回是否命中。
 */
export const TRIAGE_RULES = Object.freeze([
  {
    id: "R-PAUSE-ACTIVE",
    action: "STOP_ACTIVITY",
    summary: "存在未解除的暂停决定或逾期未完成的复评，需先由专业人员复评",
    applies: (facts) => facts.pause_active || facts.review_overdue,
  },
  {
    id: "R-RED-FLAG-UNRESOLVED",
    action: "STOP_ACTIVITY",
    summary: "近期出现胸痛、眩晕或急性损伤信号且尚未完成复评，需交给专业人员",
    applies: (facts) => facts.unresolved_red_flag,
  },
  {
    id: "R-ACUTE-INJURY-RECENT",
    action: "STOP_ACTIVITY",
    summary: (facts, t) => `自报近 ${t.recent_injury_days} 天内有急性伤情，需先由专业人员评估`,
    applies: (facts, t) =>
      facts.acute_injury_within_days !== null && facts.acute_injury_within_days <= t.recent_injury_days,
  },
  {
    id: "R-NO-PLAN",
    action: "STOP_ACTIVITY",
    summary: "尚未制定分组计划，不能按常规课程参与",
    applies: (facts) => !facts.has_plan,
  },
  {
    id: "R-SCOPE-MISSING",
    action: "STOP_ACTIVITY",
    summary: "存在自报风险但缺少医生给出的参与范围，需先咨询专业人员",
    applies: (facts) => facts.needs_scope && !facts.has_scope,
  },
  {
    id: "R-SCOPE-EXPIRED",
    action: "STOP_ACTIVITY",
    summary: "医生给出的参与范围已过期，需复评后再恢复",
    applies: (facts) => facts.has_scope && facts.scope_expired,
  },
  {
    id: "R-SCOPE-EXPIRING",
    action: "ADVISE_CONSULT",
    summary: (facts, t) => `医生参与范围将在 ${t.scope_expiring_days} 天内到期，建议尽快安排复评`,
    applies: (facts, t) =>
      facts.has_scope &&
      !facts.scope_expired &&
      facts.scope_expires_in_days !== null &&
      facts.scope_expires_in_days <= t.scope_expiring_days,
  },
  {
    id: "R-DEVICE-UNCONFIRMED",
    action: "REDUCE_LOAD",
    summary: "存在未确认的异常设备读数，确认前不得加量，先降量观察",
    applies: (facts) => facts.unconfirmed_device_abnormal,
  },
  {
    id: "R-HEAT",
    action: "REDUCE_LOAD",
    summary: (facts, t) =>
      `场地温湿度偏高（≥${t.heat_temperature_c}℃，或 ≥${t.heat_humid_temperature_c}℃ 且湿度 ≥${t.heat_humidity_pct}%），降低负荷并加强观察`,
    applies: (facts, t) =>
      facts.venue !== null &&
      (facts.venue.temperature_c >= t.heat_temperature_c ||
        (facts.venue.temperature_c >= t.heat_humid_temperature_c &&
          facts.venue.humidity_pct >= t.heat_humidity_pct)),
  },
  {
    id: "R-RPE-HIGH",
    action: "REDUCE_LOAD",
    summary: (facts, t) => `上次主观感受偏强（RPE ≥ ${t.rpe_reduce}）或报告疼痛，降量观察`,
    applies: (facts, t) =>
      (facts.last_rpe !== null && facts.last_rpe >= t.rpe_reduce) || facts.last_reported_pain,
  },
  {
    id: "R-LOAD-SPIKE",
    action: "REDUCE_LOAD",
    summary: (facts, t) => `最近负荷较既往均值上升超过 ${Math.round((t.load_spike_ratio - 1) * 100)}%，降量观察`,
    applies: (facts, t) => facts.load_spike_ratio !== null && facts.load_spike_ratio >= t.load_spike_ratio,
  },
  {
    id: "R-MOVEMENT-CONCERN",
    action: "REDUCE_LOAD",
    summary: "动作评估存在顾虑项，降量并重点关注动作质量",
    applies: (facts) => facts.movement_concerns,
  },
  {
    id: "R-SEDENTARY-START",
    action: "REDUCE_LOAD",
    summary: (facts, t) => `基础活动水平偏低，参与未满 ${t.sedentary_observation_weeks} 周，先降量观察`,
    applies: (facts, t) =>
      facts.baseline_activity === "sedentary" && facts.weeks_since_start < t.sedentary_observation_weeks,
  },
  {
    id: "R-OTHER-FLAG",
    action: "REDUCE_LOAD",
    summary: "存在其他未解决的异常信号，降量观察",
    applies: (facts) => facts.unresolved_other_flag,
  },
]);

/**
 * 加载并校验经审核的规则集。
 * 缺少审核信息、动作越界或实现与审核记录不一致时抛出错误——未获审核的规则不得启用。
 */
export function loadApprovedRuleSet(document) {
  if (document === null || typeof document !== "object") {
    throw new Error("规则集缺失或不是对象");
  }
  for (const field of ["rule_set_id", "version", "approved_by", "approved_at"]) {
    if (!document[field]) {
      throw new Error(`规则集缺少审核字段：${field}`);
    }
  }
  if (document.thresholds === null || typeof document.thresholds !== "object") {
    throw new Error("规则集缺少阈值定义");
  }
  const approved = new Map();
  for (const entry of document.rules ?? []) {
    if (!RULE_ACTIONS.includes(entry.action)) {
      throw new Error(
        `规则 ${entry.id} 的动作 ${entry.action} 超出允许范围：规则只能提示咨询、降量或停止`,
      );
    }
    approved.set(entry.id, entry);
  }
  for (const rule of TRIAGE_RULES) {
    const meta = approved.get(rule.id);
    if (!meta) {
      throw new Error(`规则 ${rule.id} 未包含在经审核的规则集中，不得启用`);
    }
    if (meta.action !== rule.action) {
      throw new Error(`规则 ${rule.id} 的实现动作与审核记录不一致`);
    }
  }
  return Object.freeze({ ...document, approved });
}

function renderReason(rule, facts, thresholds) {
  return {
    rule_id: rule.id,
    summary: typeof rule.summary === "function" ? rule.summary(facts, thresholds) : rule.summary,
  };
}

/**
 * 对一名参与者在某个场次前做三态判定。
 * @returns {{status: string, reasons: Array, advisories: Array, rule_set_version: number}}
 *   reasons 为导致降量/停止的依据，advisories 为咨询提示；两者都是可解释的中文理由。
 */
export function evaluateTriage(facts, ruleSet) {
  const hits = TRIAGE_RULES.filter((rule) => rule.applies(facts, ruleSet.thresholds));
  const stops = hits.filter((rule) => rule.action === "STOP_ACTIVITY");
  const reduces = hits.filter((rule) => rule.action === "REDUCE_LOAD");
  const advises = hits.filter((rule) => rule.action === "ADVISE_CONSULT");

  const status =
    stops.length > 0
      ? TRIAGE_STATUS.PAUSE_AND_REFER
      : reduces.length > 0
        ? TRIAGE_STATUS.REDUCE_AND_OBSERVE
        : TRIAGE_STATUS.CONTINUE;

  return {
    status,
    reasons: [...stops, ...reduces].map((rule) => renderReason(rule, facts, ruleSet.thresholds)),
    advisories: advises.map((rule) => renderReason(rule, facts, ruleSet.thresholds)),
    rule_set_version: ruleSet.version,
  };
}

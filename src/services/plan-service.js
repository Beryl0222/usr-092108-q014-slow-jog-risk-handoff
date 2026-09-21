const BASELINE_ACTIVITIES = Object.freeze(["sedentary", "light", "regular"]);

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少或非法字段：${field}`);
  }
  return value;
}

function requireNonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`字段 ${field} 必须是非负数值`);
  }
  return value;
}

/**
 * 参与者计划服务：本人目标、基础活动水平、自报风险、医生参与范围、
 * 动作评估与分组计划版本。
 *
 * 关键约束：
 * - 计划变化从下一场生效（effective_from_session_seq），既往场次的轨迹不回写；
 * - 分组计划不得超出医生给出的参与范围；
 * - 存在未确认的异常设备读数时，不得加量（由注入的钩子判定）。
 */
export class PlanService {
  #emit;
  #hooks = {
    hasUnconfirmedDeviceAbnormal: () => false,
    upcomingSessionSeq: () => 1,
  };
  #participants = new Map();

  constructor({ emit }) {
    this.#emit = emit;
  }

  /** 门面在风险服务就绪后注入跨聚合约束所需的查询。 */
  bindHooks(hooks) {
    Object.assign(this.#hooks, hooks);
  }

  #projection(participantId) {
    return this.#participants.get(participantId) ?? null;
  }

  #requireProjection(participantId) {
    const projection = this.#projection(participantId);
    if (!projection) {
      throw new Error(`参与者尚未登记：${participantId}`);
    }
    return projection;
  }

  /**
   * 登记参与者：本人目标、基础活动水平、自报风险、近期急性伤情。
   */
  registerParticipant({
    participant_id,
    display_name,
    goals,
    baseline_activity,
    self_reported_risks = [],
    recent_acute_injury = null,
  }) {
    requireString(participant_id, "participant_id");
    if (this.#projection(participant_id)) {
      throw new Error(`参与者已登记：${participant_id}`);
    }
    if (!BASELINE_ACTIVITIES.includes(baseline_activity)) {
      throw new Error(`未知基础活动水平：${baseline_activity}`);
    }
    if (!Array.isArray(goals) || goals.length === 0) {
      throw new Error("需填写本人目标 goals");
    }
    if (!Array.isArray(self_reported_risks)) {
      throw new Error("self_reported_risks 必须是数组");
    }
    if (recent_acute_injury !== null) {
      requireString(recent_acute_injury.description, "recent_acute_injury.description");
      requireString(recent_acute_injury.occurred_on, "recent_acute_injury.occurred_on");
      if (Number.isNaN(Date.parse(recent_acute_injury.occurred_on))) {
        throw new Error("recent_acute_injury.occurred_on 必须是可解析的日期");
      }
    }
    const event = this.#emit("PROFILE_REGISTERED", participant_id, {
      participant_id,
      display_name: display_name ?? null,
      goals: [...goals],
      baseline_activity,
      self_reported_risks: [...self_reported_risks],
      recent_acute_injury,
    }, `登记参与者 ${participant_id}`);
    return event.payload;
  }

  /** 记录医生给出的参与范围（可多次记录，新的覆盖旧的，历史保留）。 */
  recordPhysicianScope({
    participant_id,
    max_heart_rate,
    max_duration_min,
    restrictions = [],
    valid_until,
    issued_by,
    note = null,
  }) {
    this.#requireProjection(participant_id);
    requireNonNegativeNumber(max_heart_rate, "max_heart_rate");
    requireNonNegativeNumber(max_duration_min, "max_duration_min");
    requireString(valid_until, "valid_until");
    if (Number.isNaN(Date.parse(valid_until))) {
      throw new Error("valid_until 必须是可解析的日期");
    }
    requireString(issued_by, "issued_by");
    const event = this.#emit("PHYSICIAN_SCOPE_RECORDED", participant_id, {
      participant_id,
      max_heart_rate,
      max_duration_min,
      restrictions: [...restrictions],
      valid_until,
      issued_by,
      note,
    }, `记录医生参与范围（有效期至 ${valid_until}）`);
    return event.payload;
  }

  /** 记录动作评估。 */
  recordMovementAssessment({ participant_id, items = [], concerns = [], assessor }) {
    this.#requireProjection(participant_id);
    requireString(assessor, "assessor");
    if (!Array.isArray(items) || !Array.isArray(concerns)) {
      throw new Error("items 与 concerns 必须是数组");
    }
    const event = this.#emit("MOVEMENT_ASSESSED", participant_id, {
      participant_id,
      items: [...items],
      concerns: [...concerns],
      assessor,
    }, `记录动作评估（顾虑 ${concerns.length} 项）`);
    return event.payload;
  }

  /**
   * 审核通过一版分组计划，从下一场起生效。
   * - 不得超出医生参与范围；
   * - 存在未确认异常设备读数时不得加量；
   * - 生效场次由门面根据当前场次进度给出，保证既往轨迹不回写。
   */
  approvePlan({ participant_id, group, level, target_duration_min, target_heart_rate, approved_by, note = null }) {
    const projection = this.#requireProjection(participant_id);
    requireString(group, "group");
    requireNonNegativeNumber(target_duration_min, "target_duration_min");
    requireNonNegativeNumber(target_heart_rate, "target_heart_rate");
    requireString(approved_by, "approved_by");

    const scope = projection.scope_history.at(-1) ?? null;
    if (scope) {
      if (target_duration_min > scope.max_duration_min || target_heart_rate > scope.max_heart_rate) {
        throw new Error("分组计划不得超出医生给出的参与范围");
      }
    }
    const current = projection.plans.at(-1) ?? null;
    const isIncrease =
      current !== null &&
      (target_duration_min > current.target_duration_min || target_heart_rate > current.target_heart_rate);
    if (isIncrease && this.#hooks.hasUnconfirmedDeviceAbnormal(participant_id)) {
      throw new Error("存在未确认的异常设备读数，确认前不得加量");
    }

    const effectiveFrom = this.#hooks.upcomingSessionSeq();
    const event = this.#emit("PLAN_APPROVED", participant_id, {
      participant_id,
      plan_version: projection.plans.length + 1,
      group,
      level: level ?? null,
      target_duration_min,
      target_heart_rate,
      effective_from_session_seq: effectiveFrom,
      approved_by,
      note,
    }, `分组计划第 ${projection.plans.length + 1} 版，自第 ${effectiveFrom} 场起生效`);
    return event.payload;
  }

  // ---- 查询 ----

  profile(participantId) {
    return this.#projection(participantId)?.profile ?? null;
  }

  latestScope(participantId) {
    return this.#projection(participantId)?.scope_history.at(-1) ?? null;
  }

  scopeHistory(participantId) {
    return [...(this.#projection(participantId)?.scope_history ?? [])];
  }

  latestAssessment(participantId) {
    return this.#projection(participantId)?.assessment ?? null;
  }

  planHistory(participantId) {
    return [...(this.#projection(participantId)?.plans ?? [])];
  }

  /** 指定场次生效的计划版本（既往场次永远返回当时生效的版本，不回写）。 */
  planForSession(participantId, sessionSeq) {
    const plans = this.#projection(participantId)?.plans ?? [];
    let selected = null;
    for (const plan of plans) {
      if (plan.effective_from_session_seq <= sessionSeq) {
        selected = plan;
      }
    }
    return selected;
  }

  participantIds() {
    return [...this.#participants.keys()];
  }

  // ---- 事件回放 ----

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "PROFILE_REGISTERED": {
        this.#participants.set(payload.participant_id, {
          profile: {
            participant_id: payload.participant_id,
            display_name: payload.display_name,
            goals: payload.goals,
            baseline_activity: payload.baseline_activity,
            self_reported_risks: payload.self_reported_risks,
            recent_acute_injury: payload.recent_acute_injury,
            registered_at: event.occurred_at,
          },
          scope_history: [],
          assessment: null,
          plans: [],
        });
        break;
      }
      case "PHYSICIAN_SCOPE_RECORDED": {
        this.#projection(payload.participant_id)?.scope_history.push({
          max_heart_rate: payload.max_heart_rate,
          max_duration_min: payload.max_duration_min,
          restrictions: payload.restrictions,
          valid_until: payload.valid_until,
          issued_by: payload.issued_by,
          note: payload.note,
          recorded_at: event.occurred_at,
        });
        break;
      }
      case "MOVEMENT_ASSESSED": {
        const projection = this.#projection(payload.participant_id);
        if (projection) {
          projection.assessment = {
            items: payload.items,
            concerns: payload.concerns,
            assessor: payload.assessor,
            assessed_at: event.occurred_at,
          };
        }
        break;
      }
      case "PLAN_APPROVED": {
        this.#projection(payload.participant_id)?.plans.push({
          plan_version: payload.plan_version,
          group: payload.group,
          level: payload.level,
          target_duration_min: payload.target_duration_min,
          target_heart_rate: payload.target_heart_rate,
          effective_from_session_seq: payload.effective_from_session_seq,
          approved_by: payload.approved_by,
          note: payload.note,
          approved_at: event.occurred_at,
        });
        break;
      }
      default:
        break;
    }
  }
}

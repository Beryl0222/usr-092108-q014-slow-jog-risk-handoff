import { FLAG_KINDS, RED_FLAG_KINDS } from "../event-types.js";
import { evaluateTriage, TRIAGE_STATUS } from "../rules/triage-rules.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少或非法字段：${field}`);
  }
  return value;
}

function daysBetween(fromIso, toIso) {
  return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}

/**
 * 风险服务：异常信号、设备读数确认、三态判定、暂停决定、复评安排与紧急交接。
 *
 * 红线：
 * - 判定只依据经审核的规则集，输出三种可解释状态；
 * - 异常设备值确认前不得加量（本服务向计划服务提供该事实，并在此降量）；
 * - 胸痛、眩晕、急性损伤出现时，人工处置抢占普通课程并记录交接。
 */
export class RiskService {
  #emit;
  #clock;
  #ruleSet;
  #plan;
  #session;
  #participants = new Map();

  constructor({ emit, clock, ruleSet, plan, session }) {
    this.#emit = emit;
    this.#clock = clock;
    this.#ruleSet = ruleSet;
    this.#plan = plan;
    this.#session = session;
  }

  #projection(participantId) {
    return this.#participants.get(participantId) ?? null;
  }

  #ensureProjection(participantId) {
    let projection = this.#projection(participantId);
    if (!projection) {
      projection = { flags: [], pauses: [], reviews: [], handoffs: [], triage: new Map() };
      this.#participants.set(participantId, projection);
    }
    return projection;
  }

  // ---- 异常信号与设备确认 ----

  /** 记录异常信号（含异常设备读数）。 */
  flagRisk({ participant_id, kind, detail, source, session_id = null }) {
    requireString(participant_id, "participant_id");
    if (!FLAG_KINDS.includes(kind)) {
      throw new Error(`未知异常信号类型：${kind}`);
    }
    requireString(detail, "detail");
    requireString(source, "source");
    const flagId = `flag-${participant_id}-${(this.#projection(participant_id)?.flags.length ?? 0) + 1}`;
    const event = this.#emit("RISK_FLAGGED", participant_id, {
      participant_id,
      flag_id: flagId,
      kind,
      detail,
      source,
      session_id,
    }, `异常信号：${participant_id} ${kind}`);
    return event.payload;
  }

  /** 确认异常设备读数（有效或无效）；确认前该读数阻止加量。 */
  resolveDeviceReading({ participant_id, flag_id, resolution, resolved_by, note = null }) {
    const projection = this.#projection(participant_id);
    const flag = projection?.flags.find((item) => item.flag_id === flag_id);
    if (!flag) {
      throw new Error(`异常信号不存在：${flag_id}`);
    }
    if (flag.kind !== "abnormal_device_value") {
      throw new Error("只有异常设备读数可以通过此操作确认");
    }
    if (flag.resolved) {
      throw new Error("该读数已确认，不得重复操作");
    }
    if (!["confirmed_valid", "confirmed_invalid"].includes(resolution)) {
      throw new Error("resolution 必须是 confirmed_valid 或 confirmed_invalid");
    }
    requireString(resolved_by, "resolved_by");
    const event = this.#emit("DEVICE_READING_RESOLVED", participant_id, {
      participant_id,
      flag_id,
      resolution,
      resolved_by,
      note,
    }, `确认设备读数 ${flag_id}：${resolution}`);
    return event.payload;
  }

  /** 是否存在未确认的异常设备读数（计划服务据此阻止加量）。 */
  hasUnconfirmedDeviceAbnormal(participantId) {
    return (this.#projection(participantId)?.flags ?? []).some(
      (flag) => flag.kind === "abnormal_device_value" && !flag.resolved,
    );
  }

  // ---- 三态判定 ----

  /**
   * 在某场次前对参与者做三态判定，并把判定结果（含依据）落为 TRIAGE_DECIDED 事件。
   * 判定是追加记录：重新判定产生新版本，既往判定不回写。
   */
  triage({ participant_id, session_id }) {
    const profile = this.#plan.profile(participant_id);
    if (!profile) {
      throw new Error(`参与者尚未登记：${participant_id}`);
    }
    const session = this.#session.get(session_id);
    if (!session) {
      throw new Error(`场次不存在：${session_id}`);
    }

    const facts = this.#buildFacts(participant_id, session);
    const decision = evaluateTriage(facts, this.#ruleSet);
    const plan = facts.plan;
    const constraints = this.#computeConstraints(plan, facts.scope, decision.status);

    const event = this.#emit("TRIAGE_DECIDED", participant_id, {
      participant_id,
      session_id,
      status: decision.status,
      reasons: decision.reasons,
      advisories: decision.advisories,
      constraints,
      plan_version: plan?.plan_version ?? null,
      rule_set_version: decision.rule_set_version,
    }, `判定 ${participant_id} 于 ${session_id}：${decision.status}`);
    return event.payload;
  }

  #buildFacts(participantId, session) {
    const profile = this.#plan.profile(participantId);
    const scope = this.#plan.latestScope(participantId);
    const assessment = this.#plan.latestAssessment(participantId);
    const plan = this.#plan.planForSession(participantId, session.seq);
    const projection = this.#projection(participantId);
    const flags = projection?.flags ?? [];
    const now = this.#clock();

    const feedback = this.#session.lastFeedbackBefore(participantId, session.seq);
    const history = this.#session
      .loadHistory(participantId, { beforeSeq: session.seq })
      .filter((entry) => entry.metrics !== null);
    const loadSpikeRatio = this.#loadSpikeRatio(history);

    const firstDate = this.#session.firstParticipationDate(participantId);
    const weeksSinceStart = firstDate === null ? 0 : Math.max(0, daysBetween(firstDate, session.scheduled_at) / 7);

    const scopeExpired = scope !== null && scope.valid_until < session.scheduled_at;
    const scopeExpiresInDays =
      scope === null ? null : daysBetween(session.scheduled_at, scope.valid_until);

    const openReview = (projection?.reviews ?? []).find((review) => review.status === "open") ?? null;

    return {
      plan,
      scope,
      has_plan: plan !== null,
      pause_active: this.pauseActive(participantId),
      review_overdue: openReview !== null && openReview.due_before < now,
      unresolved_red_flag: flags.some((flag) => RED_FLAG_KINDS.includes(flag.kind) && !flag.resolved),
      unresolved_other_flag: flags.some(
        (flag) => !RED_FLAG_KINDS.includes(flag.kind) && flag.kind !== "abnormal_device_value" && !flag.resolved,
      ),
      unconfirmed_device_abnormal: this.hasUnconfirmedDeviceAbnormal(participantId),
      acute_injury_within_days: profile.recent_acute_injury
        ? daysBetween(profile.recent_acute_injury.occurred_on, session.scheduled_at)
        : null,
      needs_scope: profile.self_reported_risks.length > 0,
      has_scope: scope !== null,
      scope_expired: scopeExpired,
      scope_expires_in_days: scopeExpiresInDays,
      venue: session.venue,
      last_rpe: feedback?.rpe ?? null,
      last_reported_pain: feedback?.pain ?? false,
      load_spike_ratio: loadSpikeRatio,
      movement_concerns: (assessment?.concerns.length ?? 0) > 0,
      baseline_activity: profile.baseline_activity,
      weeks_since_start: weeksSinceStart,
    };
  }

  #loadSpikeRatio(history) {
    const minHistory = this.#ruleSet.thresholds.load_spike_min_history ?? 2;
    if (history.length < minHistory + 1) {
      return null;
    }
    const recent = history.at(-1).metrics.duration_min;
    const prior = history.slice(-(minHistory + 1), -1).map((entry) => entry.metrics.duration_min);
    const baseline = prior.reduce((sum, value) => sum + value, 0) / prior.length;
    if (baseline <= 0) {
      return null;
    }
    return recent / baseline;
  }

  #computeConstraints(plan, scope, status) {
    if (!plan || status === TRIAGE_STATUS.PAUSE_AND_REFER) {
      return null;
    }
    let maxDuration = plan.target_duration_min;
    let maxHeartRate = plan.target_heart_rate;
    if (scope) {
      maxDuration = Math.min(maxDuration, scope.max_duration_min);
      maxHeartRate = Math.min(maxHeartRate, scope.max_heart_rate);
    }
    if (status === TRIAGE_STATUS.REDUCE_AND_OBSERVE) {
      maxDuration = Math.max(5, Math.floor(maxDuration * 0.8));
    }
    return { max_duration_min: maxDuration, max_heart_rate: maxHeartRate };
  }

  /** 某场次最近一次判定（可能为 null）。 */
  latestTriage(participantId, sessionId) {
    return this.#projection(participantId)?.triage.get(sessionId) ?? null;
  }

  /** 全部判定历史（按时间序）。 */
  triageHistory(participantId) {
    const triage = this.#projection(participantId)?.triage;
    if (!triage) {
      return [];
    }
    return [...triage.values()];
  }

  // ---- 暂停与复评 ----

  pauseActive(participantId) {
    return (this.#projection(participantId)?.pauses ?? []).some((pause) => pause.active);
  }

  openReview(participantId) {
    return (this.#projection(participantId)?.reviews ?? []).find((review) => review.status === "open") ?? null;
  }

  /** 人工暂停决定。 */
  pause({ participant_id, reason, decided_by }) {
    requireString(participant_id, "participant_id");
    requireString(reason, "reason");
    requireString(decided_by, "decided_by");
    if (this.pauseActive(participant_id)) {
      throw new Error("已存在未解除的暂停决定");
    }
    const event = this.#emit("ACTIVITY_PAUSED", participant_id, {
      participant_id,
      reason,
      decided_by,
      trigger: "manual",
    }, `暂停参与：${participant_id}`);
    return event.payload;
  }

  /** 安排复评。 */
  scheduleReview({ participant_id, due_before, reviewer, reason }) {
    requireString(participant_id, "participant_id");
    requireString(due_before, "due_before");
    if (Number.isNaN(Date.parse(due_before))) {
      throw new Error("due_before 必须是可解析的时间字符串");
    }
    requireString(reviewer, "reviewer");
    requireString(reason, "reason");
    if (this.openReview(participant_id)) {
      throw new Error("已存在待完成的复评安排");
    }
    const reviewId = `review-${participant_id}-${(this.#projection(participant_id)?.reviews.length ?? 0) + 1}`;
    const event = this.#emit("REVIEW_SCHEDULED", participant_id, {
      participant_id,
      review_id: reviewId,
      due_before,
      reviewer,
      reason,
    }, `安排复评：${participant_id}（${due_before} 前）`);
    return event.payload;
  }

  /** 完成复评：解除暂停、了结未决异常信号。 */
  completeReview({ participant_id, reviewer, outcome, note = null }) {
    requireString(participant_id, "participant_id");
    requireString(reviewer, "reviewer");
    requireString(outcome, "outcome");
    const openReview = this.openReview(participant_id);
    if (!openReview && !this.pauseActive(participant_id)) {
      throw new Error("没有待完成的复评或未解除的暂停");
    }
    const event = this.#emit("REVIEW_COMPLETED", participant_id, {
      participant_id,
      review_id: openReview?.review_id ?? null,
      reviewer,
      outcome,
      note,
    }, `完成复评：${participant_id}`);
    return event.payload;
  }

  // ---- 紧急处置 ----

  /**
   * 胸痛、眩晕或急性损伤出现时的人工处置：
   * 抢占普通课程（场次登记事故）、立即暂停、记录交接、安排复评。
   */
  declareEmergency({ participant_id, session_id, kind, handled_by, handoff_to, note = null, review_due_before = null }) {
    requireString(participant_id, "participant_id");
    requireString(session_id, "session_id");
    if (!RED_FLAG_KINDS.includes(kind)) {
      throw new Error(`紧急处置仅适用于：${RED_FLAG_KINDS.join("、")}`);
    }
    requireString(handled_by, "handled_by");
    requireString(handoff_to, "handoff_to");
    if (!this.#session.get(session_id)) {
      throw new Error(`场次不存在：${session_id}`);
    }

    this.flagRisk({
      participant_id,
      kind,
      detail: note ?? `课程中出现 ${kind}`,
      source: "onsite_staff",
      session_id,
    });
    if (!this.pauseActive(participant_id)) {
      this.#emit("ACTIVITY_PAUSED", participant_id, {
        participant_id,
        reason: `课程中出现${kind === "chest_pain" ? "胸痛" : kind === "dizziness" ? "眩晕" : "急性损伤"}，人工处置抢占普通课程`,
        decided_by: handled_by,
        trigger: "emergency",
      }, `紧急暂停：${participant_id}`);
    }
    const handoffId = `handoff-${participant_id}-${(this.#projection(participant_id)?.handoffs.length ?? 0) + 1}`;
    const handoff = this.#emit("HANDOFF_RECORDED", participant_id, {
      participant_id,
      handoff_id: handoffId,
      session_id,
      kind,
      handled_by,
      handoff_to,
      preempted_session: true,
      note,
    }, `人工交接：${participant_id} → ${handoff_to}`);
    if (!this.openReview(participant_id)) {
      const dueBefore = review_due_before ?? new Date(Date.parse(this.#clock()) + 7 * DAY_MS).toISOString();
      this.scheduleReview({
        participant_id,
        due_before: dueBefore,
        reviewer: handoff_to,
        reason: "紧急处置后的复评",
      });
    }
    return handoff.payload;
  }

  // ---- 查询（供视图） ----

  flags(participantId) {
    return [...(this.#projection(participantId)?.flags ?? [])];
  }

  pauses(participantId) {
    return [...(this.#projection(participantId)?.pauses ?? [])];
  }

  reviews(participantId) {
    return [...(this.#projection(participantId)?.reviews ?? [])];
  }

  handoffs(participantId) {
    return [...(this.#projection(participantId)?.handoffs ?? [])];
  }

  participantIds() {
    return [...this.#participants.keys()];
  }

  // ---- 事件回放 ----

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "RISK_FLAGGED": {
        this.#ensureProjection(payload.participant_id).flags.push({
          flag_id: payload.flag_id,
          kind: payload.kind,
          detail: payload.detail,
          source: payload.source,
          session_id: payload.session_id ?? null,
          occurred_at: event.occurred_at,
          resolved: false,
          resolution: null,
        });
        break;
      }
      case "DEVICE_READING_RESOLVED": {
        const flag = this.#projection(payload.participant_id)?.flags.find(
          (item) => item.flag_id === payload.flag_id,
        );
        if (flag) {
          flag.resolved = true;
          flag.resolution = payload.resolution;
          flag.resolved_by = payload.resolved_by;
          flag.resolution_note = payload.note ?? null;
        }
        break;
      }
      case "TRIAGE_DECIDED": {
        this.#ensureProjection(payload.participant_id).triage.set(payload.session_id, {
          session_id: payload.session_id,
          status: payload.status,
          reasons: payload.reasons,
          advisories: payload.advisories,
          constraints: payload.constraints,
          plan_version: payload.plan_version ?? null,
          rule_set_version: payload.rule_set_version,
          decided_at: event.occurred_at,
        });
        break;
      }
      case "ACTIVITY_PAUSED": {
        this.#ensureProjection(payload.participant_id).pauses.push({
          reason: payload.reason,
          decided_by: payload.decided_by,
          trigger: payload.trigger,
          paused_at: event.occurred_at,
          active: true,
        });
        break;
      }
      case "HANDOFF_RECORDED": {
        this.#ensureProjection(payload.participant_id).handoffs.push({
          handoff_id: payload.handoff_id,
          session_id: payload.session_id,
          kind: payload.kind,
          handled_by: payload.handled_by,
          handoff_to: payload.handoff_to,
          preempted_session: payload.preempted_session ?? true,
          note: payload.note ?? null,
          occurred_at: event.occurred_at,
        });
        break;
      }
      case "REVIEW_SCHEDULED": {
        this.#ensureProjection(payload.participant_id).reviews.push({
          review_id: payload.review_id,
          due_before: payload.due_before,
          reviewer: payload.reviewer,
          reason: payload.reason,
          status: "open",
          scheduled_at: event.occurred_at,
        });
        break;
      }
      case "REVIEW_COMPLETED": {
        const projection = this.#ensureProjection(payload.participant_id);
        const review = projection.reviews.find(
          (item) => item.review_id === payload.review_id && item.status === "open",
        );
        if (review) {
          review.status = "completed";
          review.completed_at = event.occurred_at;
          review.outcome = payload.outcome;
          review.completed_by = payload.reviewer;
        }
        for (const pause of projection.pauses) {
          pause.active = false;
        }
        for (const flag of projection.flags) {
          if (!flag.resolved) {
            flag.resolved = true;
            flag.resolution = "review_completed";
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

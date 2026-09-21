import { EventStore } from "./event-store.js";
import {
  PARTICIPANT_STATES,
  RECORD_SOURCES,
  RED_FLAG_SIGNALS,
  REVIEW_OUTCOMES,
  SIGNAL_TYPES,
  SOURCE_PRECEDENCE,
} from "./domain.js";
import { createRule, evaluateCondition } from "./rules.js";
import { validateEvent } from "./validator.js";

const RED_FLAG_SET = new Set(RED_FLAG_SIGNALS);

/** 设备读数合理区间；超出即判为异常设备值，确认前不计入负荷历史、不允许加量。 */
const PLAUSIBLE_RANGES = Object.freeze({
  avg_hr: [30, 220],
  duration_min: [1, 300],
  rpe: [0, 10],
});

/** 多源记录数值互相矛盾的容忍阈值（时长相对差 20%、心率 15 次、RPE 2 级）。 */
const CONFLICT_TOLERANCE = Object.freeze({ duration_min: 0.2, avg_hr: 15, rpe: 2 });

/**
 * 超慢跑风险接力服务。
 *
 * 每场活动前把参与者落入三种可解释状态之一：继续 / 降量观察 / 暂停并交接专业人员。
 * 所有业务事实以追加事件落账，既往轨迹不回写；计划变化自下一场生效。
 */
export class RiskHandoffService {
  #store;
  #now;
  #seq = 0;
  #participants = new Map();
  #sessions = new Map();
  #rules = new Map();
  #loadRecords = new Map();
  #submissions = new Map();
  #attendanceByDay = new Map();

  constructor({ store, now } = {}) {
    this.#store = store ?? new EventStore();
    this.#now = now ?? (() => new Date());
  }

  // ---------- 基础设施 ----------

  #nextId(prefix) {
    this.#seq += 1;
    return `${prefix}-${this.#now().getTime().toString(36)}-${this.#seq.toString(36)}`;
  }

  #emit(eventType, aggregateType, aggregateId, summary, payload = {}) {
    const event = {
      event_id: this.#nextId("evt"),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#now().toISOString(),
      version: this.#store.byAggregate(aggregateType, aggregateId).length + 1,
      summary,
      payload,
    };
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件不符合领域约定：${errors.join("；")}`);
    return this.#store.append(event);
  }

  /** 审计用：按接收顺序返回全部领域事件。 */
  events() {
    return this.#store.all();
  }

  #participant(id) {
    const p = this.#participants.get(id);
    if (!p) throw new Error(`未知参与者：${id}`);
    return p;
  }

  #session(id) {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`未知场次：${id}`);
    return s;
  }

  #slot(session, participantId) {
    let slot = session.records.get(participantId);
    if (!slot) {
      slot = { attendance: null, absence: null, loads: [], preempted: false };
      session.records.set(participantId, slot);
    }
    return slot;
  }

  /** 幂等：同一 submission_id 的网络重传返回首次受理结果，不重复累计。 */
  #dedup(submissionId) {
    if (submissionId && this.#submissions.has(submissionId)) {
      return { ...this.#submissions.get(submissionId), counted: false, deduped: true, dedup_reason: "retransmission" };
    }
    return null;
  }

  #remember(submissionId, result) {
    if (submissionId) this.#submissions.set(submissionId, { ...result });
    return result;
  }

  // ---------- 建档：本人目标、基础活动水平、自报风险 ----------

  registerParticipant({ participant_id, display_name, goals, baseline_activity, self_reported_risks = [] }) {
    if (!participant_id) throw new Error("缺少 participant_id");
    if (this.#participants.has(participant_id)) throw new Error(`参与者已存在：${participant_id}`);
    if (!goals || typeof goals.text !== "string") throw new Error("缺少本人目标 goals.text");
    if (!baseline_activity || !Number.isInteger(baseline_activity.level)) {
      throw new Error("缺少基础活动水平 baseline_activity.level");
    }
    const profile = {
      participant_id,
      display_name: display_name ?? participant_id,
      goals: { ...goals },
      baseline_activity: { ...baseline_activity },
      self_reported_risks: self_reported_risks.map((r) => ({ ...r })),
      medical_scope: null,
      movement_assessment: null,
      plans: [],
      pauses: [],
      reviews: [],
      signals: [],
      handoffs: [],
    };
    this.#participants.set(participant_id, profile);
    this.#emit("PROFILE_REGISTERED", "participant_profile", participant_id, "登记参与者档案：本人目标、基础活动水平、自报风险", {
      display_name: profile.display_name,
      goals: profile.goals,
      baseline_activity: profile.baseline_activity,
      self_reported_risks: profile.self_reported_risks,
    });
    return profile;
  }

  /** 医生给出的参与范围（仅约束参与边界，不构成诊断或治疗变更）。 */
  recordMedicalScope(participantId, scope) {
    const p = this.#participant(participantId);
    if (!scope || !scope.issued_by) throw new Error("医生参与范围需注明 issued_by");
    p.medical_scope = { ...scope, recorded_at: this.#now().toISOString() };
    this.#emit("MEDICAL_SCOPE_RECORDED", "participant_profile", participantId, "记录医生给出的参与范围", { scope: p.medical_scope });
    return p.medical_scope;
  }

  recordMovementAssessment(participantId, assessment) {
    const p = this.#participant(participantId);
    if (!assessment || !assessment.assessor) throw new Error("动作评估需注明 assessor");
    p.movement_assessment = { cautions: [], ...assessment, recorded_at: this.#now().toISOString() };
    this.#emit("MOVEMENT_ASSESSED", "participant_profile", participantId, "记录动作评估", { assessment: p.movement_assessment });
    return p.movement_assessment;
  }

  // ---------- 分组计划：版本化，自下一场生效，既往轨迹不回写 ----------

  approvePlan({ participant_id, group, weekly_sessions, target_load, decided_by, note = "" }) {
    const p = this.#participant(participant_id);
    if (!group) throw new Error("缺少分组 group");
    if (!Number.isFinite(target_load) || target_load <= 0) throw new Error("target_load 必须为正数");
    const prev = this.#currentPlan(p);
    if (prev && target_load > prev.target_load && this.#pendingAnomalies(participant_id).length > 0) {
      throw new Error("存在未确认的异常设备值，确认前不得加量");
    }
    const plan = {
      version: p.plans.length + 1,
      group,
      weekly_sessions: weekly_sessions ?? prev?.weekly_sessions ?? null,
      target_load,
      decided_by: decided_by ?? "system",
      note,
      approved_at: this.#now().toISOString(),
      effective_from: this.#now().toISOString(),
    };
    p.plans.push(plan);
    this.#emit("PLAN_APPROVED", "participant_plan", participant_id, `审批分组计划 v${plan.version}（${group}，目标负荷 ${target_load}）`, { plan });
    return plan;
  }

  #currentPlan(p) {
    return p.plans.length > 0 ? p.plans[p.plans.length - 1] : null;
  }

  // ---------- 审核规则：只提示咨询、降量或停止 ----------

  registerRule(input) {
    const rule = createRule(input);
    if (this.#rules.has(rule.rule_id)) throw new Error(`规则已存在：${rule.rule_id}`);
    this.#rules.set(rule.rule_id, rule);
    this.#emit("RULE_REGISTERED", "safety_rule", rule.rule_id, `登记审核规则：${rule.description || rule.rule_id}（${rule.action}）`, { rule });
    return rule;
  }

  // ---------- 场次与场地温湿度 ----------

  createSession({ session_id, site_id, scheduled_at, temperature_c, humidity_pct, coach_id }) {
    if (!session_id) throw new Error("缺少 session_id");
    if (this.#sessions.has(session_id)) throw new Error(`场次已存在：${session_id}`);
    if (!scheduled_at || Number.isNaN(Date.parse(scheduled_at))) throw new Error("scheduled_at 必须是有效日期时间");
    const session = {
      session_id,
      site_id: site_id ?? "default",
      scheduled_at,
      date: scheduled_at.slice(0, 10),
      temperature_c: temperature_c ?? null,
      humidity_pct: humidity_pct ?? null,
      coach_id: coach_id ?? null,
      records: new Map(),
    };
    this.#sessions.set(session_id, session);
    this.#emit("SESSION_RECORDED", "activity_session", session_id, "创建场次并记录场地温湿度", {
      site_id: session.site_id,
      scheduled_at,
      temperature_c: session.temperature_c,
      humidity_pct: session.humidity_pct,
      coach_id: session.coach_id,
    });
    return session;
  }

  // ---------- 到场、缺席与负荷：多源、幂等、只累计一次 ----------

  recordAttendance({ session_id, participant_id, source = "manual_checkin", submission_id, recorded_at }) {
    const dup = this.#dedup(submission_id);
    if (dup) return dup;
    const session = this.#session(session_id);
    const p = this.#participant(participant_id);
    const dayKey = `${participant_id}|${session.date}`;
    const existing = this.#attendanceByDay.get(dayKey);
    if (existing) {
      // 同人同日只累计一次：同场重复签到或跨点参加都不重复计数
      const reason = existing.session_id === session_id ? "duplicate" : "cross_site";
      return this.#remember(submission_id, {
        participant_id,
        session_id,
        counted: false,
        deduped: true,
        dedup_reason: reason,
        kept_session_id: existing.session_id,
      });
    }
    this.#attendanceByDay.set(dayKey, { session_id });
    this.#slot(session, participant_id).attendance = { source, recorded_at: recorded_at ?? this.#now().toISOString() };
    this.#emit("ATTENDANCE_RECORDED", "activity_session", session_id, `记录到场：${p.display_name}`, { participant_id, source });
    return this.#remember(submission_id, { participant_id, session_id, counted: true, deduped: false });
  }

  recordAbsence({ session_id, participant_id, submission_id, reason = "" }) {
    const dup = this.#dedup(submission_id);
    if (dup) return dup;
    const session = this.#session(session_id);
    this.#participant(participant_id);
    const slot = this.#slot(session, participant_id);
    if (slot.absence) {
      return this.#remember(submission_id, { participant_id, session_id, counted: false, deduped: true, dedup_reason: "duplicate" });
    }
    slot.absence = { reason, recorded_at: this.#now().toISOString() };
    this.#emit("ABSENCE_RECORDED", "activity_session", session_id, `记录缺席：${participant_id}`, { participant_id, reason });
    return this.#remember(submission_id, { participant_id, session_id, counted: true, deduped: false });
  }

  /** 记录每次负荷与主观感受；异常设备值进入待确认状态，确认前不计入负荷历史。 */
  recordLoad({ session_id, participant_id, source, submission_id, duration_min, avg_hr, distance_km, rpe, recorded_at }) {
    const dup = this.#dedup(submission_id);
    if (dup) return dup;
    const session = this.#session(session_id);
    const p = this.#participant(participant_id);
    if (!RECORD_SOURCES.includes(source)) {
      throw new Error(`未知记录来源：${source}（支持 ${RECORD_SOURCES.join("、")}）`);
    }
    const values = { avg_hr, duration_min, rpe };
    const anomalies = Object.entries(PLAUSIBLE_RANGES)
      .filter(([field, [lo, hi]]) => values[field] != null && (values[field] < lo || values[field] > hi))
      .map(([field]) => field);
    const plan = this.#currentPlan(p);
    const record = {
      record_id: this.#nextId("load"),
      session_id,
      participant_id,
      source,
      duration_min: duration_min ?? null,
      avg_hr: avg_hr ?? null,
      distance_km: distance_km ?? null,
      rpe: rpe ?? null,
      recorded_at: recorded_at ?? this.#now().toISOString(),
      plan_version: plan?.version ?? null,
      status: anomalies.length > 0 ? "PENDING_CONFIRMATION" : "CONFIRMED",
      anomalies,
      conflict: false,
      supersedes: null,
    };
    this.#loadRecords.set(record.record_id, record);
    this.#slot(session, participant_id).loads.push(record.record_id);
    this.#markConflicts(session_id, participant_id);
    if (anomalies.length > 0) {
      this.#emit("DEVICE_ANOMALY_FLAGGED", "risk_observation", record.record_id, `异常设备值待确认（${anomalies.join("、")}），确认前不加量`, {
        participant_id,
        session_id,
        source,
        anomalies,
      });
    }
    this.#emit("LOAD_RECORDED", "activity_session", session_id, `记录负荷：${p.display_name} ${duration_min ?? "?"} 分钟，RPE ${rpe ?? "?"}`, {
      record_id: record.record_id,
      participant_id,
      source,
      status: record.status,
    });
    return this.#remember(submission_id, {
      record_id: record.record_id,
      participant_id,
      session_id,
      status: record.status,
      anomalies,
      counted: true,
      deduped: false,
    });
  }

  /** 确认或更正异常设备值；更正产生后继记录，原记录标记为被取代，不原地改写。 */
  confirmLoad({ record_id, confirmed_by, corrected = null, reject = false }) {
    const rec = this.#loadRecords.get(record_id);
    if (!rec) throw new Error(`未知负荷记录：${record_id}`);
    if (rec.status !== "PENDING_CONFIRMATION") throw new Error("该记录不在待确认状态");
    if (!confirmed_by) throw new Error("确认需注明 confirmed_by");
    if (reject) {
      rec.status = "REJECTED";
      this.#emit("DEVICE_VALUE_CONFIRMED", "risk_observation", record_id, "异常设备值确认为无效，予以剔除", {
        participant_id: rec.participant_id,
        confirmed_by,
        rejected: true,
      });
      return { record_id, status: "REJECTED" };
    }
    if (corrected && Object.keys(corrected).length > 0) {
      const merged = { avg_hr: rec.avg_hr, duration_min: rec.duration_min, rpe: rec.rpe, ...corrected };
      const stillBad = Object.entries(PLAUSIBLE_RANGES)
        .filter(([field, [lo, hi]]) => merged[field] != null && (merged[field] < lo || merged[field] > hi))
        .map(([field]) => field);
      if (stillBad.length > 0) throw new Error(`更正值仍超出合理范围：${stillBad.join("、")}`);
      const successor = {
        ...rec,
        ...corrected,
        record_id: this.#nextId("load"),
        status: "CONFIRMED",
        anomalies: [],
        conflict: false,
        supersedes: record_id,
        confirmed_by,
      };
      rec.status = "SUPERSEDED";
      this.#loadRecords.set(successor.record_id, successor);
      this.#slot(this.#session(rec.session_id), rec.participant_id).loads.push(successor.record_id);
      this.#markConflicts(rec.session_id, rec.participant_id);
      this.#emit("DEVICE_VALUE_CONFIRMED", "risk_observation", record_id, "异常设备值经人工更正并确认", {
        participant_id: rec.participant_id,
        confirmed_by,
        successor_id: successor.record_id,
        corrected,
      });
      return { record_id: successor.record_id, status: "CONFIRMED", supersedes: record_id };
    }
    rec.status = "CONFIRMED";
    rec.confirmed_by = confirmed_by;
    this.#markConflicts(rec.session_id, rec.participant_id);
    this.#emit("DEVICE_VALUE_CONFIRMED", "risk_observation", record_id, "异常设备值经人工确认有效", {
      participant_id: rec.participant_id,
      confirmed_by,
    });
    return { record_id, status: "CONFIRMED" };
  }

  /** 同场同人多来源且数值差异超阈值时，互相标注冲突；采信优先级见 SOURCE_PRECEDENCE。 */
  #markConflicts(sessionId, participantId) {
    const records = [...this.#loadRecords.values()]
      .filter((r) => r.session_id === sessionId && r.participant_id === participantId && r.status === "CONFIRMED")
      .sort((a, b) => SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source));
    for (const rec of records) rec.conflict = false;
    const base = records[0];
    if (!base) return;
    for (const rec of records.slice(1)) {
      if (this.#valuesConflict(base, rec)) {
        base.conflict = true;
        rec.conflict = true;
      }
    }
  }

  #valuesConflict(a, b) {
    if (a.source === b.source) return false;
    if (a.duration_min != null && b.duration_min != null && a.duration_min > 0) {
      if (Math.abs(a.duration_min - b.duration_min) / a.duration_min > CONFLICT_TOLERANCE.duration_min) return true;
    }
    if (a.avg_hr != null && b.avg_hr != null && Math.abs(a.avg_hr - b.avg_hr) > CONFLICT_TOLERANCE.avg_hr) return true;
    if (a.rpe != null && b.rpe != null && Math.abs(a.rpe - b.rpe) > CONFLICT_TOLERANCE.rpe) return true;
    return false;
  }

  // ---------- 异常信号、人工处置抢占、暂停与复评 ----------

  /** 上报异常信号；胸痛、眩晕、急性损伤立即由人工处置抢占普通课程并记录交接。 */
  reportSignal({ participant_id, session_id = null, signal, note = "", reported_by }) {
    const p = this.#participant(participant_id);
    if (!SIGNAL_TYPES.includes(signal)) throw new Error(`未知异常信号：${signal}`);
    if (session_id) this.#session(session_id);
    const sig = {
      signal_id: this.#nextId("sig"),
      participant_id,
      session_id,
      signal,
      note,
      reported_by: reported_by ?? "system",
      reported_at: this.#now().toISOString(),
      handled: false,
      handoff_id: null,
    };
    p.signals.push(sig);
    this.#emit("RISK_FLAGGED", "risk_observation", sig.signal_id, `异常信号：${signal}（${p.display_name}）`, {
      participant_id,
      session_id,
      signal,
      note,
    });
    if (RED_FLAG_SET.has(signal)) this.#preempt(sig, p);
    return sig;
  }

  /** 人工处置抢占：中断该参与者本场普通课程，记录交接，并作出暂停决定。 */
  #preempt(sig, p) {
    const handoff = {
      handoff_id: this.#nextId("handoff"),
      participant_id: sig.participant_id,
      session_id: sig.session_id,
      signal: sig.signal,
      note: sig.note,
      received_by: sig.reported_by,
      handed_at: this.#now().toISOString(),
    };
    p.handoffs.push(handoff);
    sig.handled = true;
    sig.handoff_id = handoff.handoff_id;
    if (sig.session_id) {
      this.#slot(this.#session(sig.session_id), sig.participant_id).preempted = true;
    }
    this.#emit("HANDOFF_RECORDED", "clinical_handoff", handoff.handoff_id, `人工处置抢占普通课程并交接：${sig.signal}`, { ...handoff });
    this.#pauseInternal(p, {
      decided_by: sig.reported_by,
      reason: `红旗信号「${sig.signal}」：人工处置抢占普通课程，暂停并交接专业人员`,
      signal_id: sig.signal_id,
    });
  }

  /** 人工暂停决定。 */
  pause(participant_id, { decided_by, reason }) {
    const p = this.#participant(participant_id);
    if (!reason) throw new Error("暂停决定需说明理由");
    return this.#pauseInternal(p, { decided_by: decided_by ?? "staff", reason });
  }

  #pauseInternal(p, { decided_by, reason, signal_id = null }) {
    const pause = {
      pause_id: this.#nextId("pause"),
      participant_id: p.participant_id,
      decided_by,
      reason,
      signal_id,
      decided_at: this.#now().toISOString(),
      lifted_by: null,
    };
    p.pauses.push(pause);
    this.#emit("ACTIVITY_PAUSED", "pause_decision", pause.pause_id, `暂停决定：${reason}`, {
      participant_id: p.participant_id,
      decided_by,
      reason,
    });
    return pause;
  }

  /** 安排复评。 */
  scheduleReview(participant_id, { reviewer, due_at, note = "" }) {
    const p = this.#participant(participant_id);
    if (!reviewer || !due_at) throw new Error("复评安排需注明 reviewer 与 due_at");
    const review = {
      review_id: this.#nextId("review"),
      participant_id,
      reviewer,
      due_at,
      note,
      status: "scheduled",
      scheduled_at: this.#now().toISOString(),
      completed_at: null,
      outcome: null,
    };
    p.reviews.push(review);
    this.#emit("REVIEW_SCHEDULED", "review_schedule", review.review_id, `安排复评：${reviewer} 于 ${due_at}`, {
      participant_id,
      reviewer,
      due_at,
    });
    return review;
  }

  /** 完成复评；结论为恢复时解除最早一条未解除的暂停。 */
  completeReview(participant_id, review_id, { outcome, note = "" }) {
    const p = this.#participant(participant_id);
    const review = p.reviews.find((r) => r.review_id === review_id);
    if (!review) throw new Error(`未知复评：${review_id}`);
    if (review.status !== "scheduled") throw new Error("该复评已完成");
    if (!REVIEW_OUTCOMES.includes(outcome)) throw new Error(`复评结论仅限：${REVIEW_OUTCOMES.join("、")}`);
    review.status = "completed";
    review.completed_at = this.#now().toISOString();
    review.outcome = outcome;
    review.note = note;
    if (outcome !== "continue_pause") {
      const open = p.pauses.find((x) => !x.lifted_by);
      if (open) open.lifted_by = review_id;
    }
    this.#emit("REVIEW_COMPLETED", "review_schedule", review_id, `完成复评：${outcome}`, { participant_id, outcome, note });
    return review;
  }

  // ---------- 可解释状态评估 ----------

  /** 评估参与者在某场次前的状态，并给出可解释依据。 */
  assess(participant_id, session_id = null) {
    const p = this.#participant(participant_id);
    const session = session_id ? this.#session(session_id) : null;
    const facts = this.#facts(p, session);
    const reasons = [];
    const advice = [];
    const assessed_at = this.#now().toISOString();

    const openPause = p.pauses.find((x) => !x.lifted_by);
    if (openPause) {
      reasons.push({ code: "PAUSE_ACTIVE", detail: `存在未解除的暂停决定：${openPause.reason}` });
      const handoff = p.handoffs[p.handoffs.length - 1];
      if (handoff) {
        reasons.push({ code: "HANDOFF_RECORDED", detail: `已于 ${handoff.handed_at} 交接专业人员（接收：${handoff.received_by}）` });
      }
      const pendingReview = p.reviews.find((r) => r.status === "scheduled");
      if (pendingReview) {
        reasons.push({ code: "REVIEW_SCHEDULED", detail: `复评安排：${pendingReview.due_at} 由 ${pendingReview.reviewer} 复评` });
      }
      return { participant_id, state: PARTICIPANT_STATES.PAUSE_HANDOFF, reasons, advice, assessed_at };
    }

    const unhandledRed = p.signals.filter((s) => RED_FLAG_SET.has(s.signal) && !s.handled);
    if (unhandledRed.length > 0) {
      reasons.push({ code: "UNHANDLED_RED_FLAG", detail: `存在未处置的红旗信号：${unhandledRed.map((s) => s.signal).join("、")}` });
      return { participant_id, state: PARTICIPANT_STATES.PAUSE_HANDOFF, reasons, advice, assessed_at };
    }

    // 复评结论为降量恢复：恢复后的首场先降低负荷观察
    const completedReviews = p.reviews.filter((r) => r.status === "completed");
    const lastReview = completedReviews[completedReviews.length - 1];
    if (lastReview?.outcome === "resume_reduced") {
      const resumed = this.#trustedHistory(participant_id).some((r) => Date.parse(r.recorded_at) > Date.parse(lastReview.completed_at));
      if (!resumed) {
        reasons.push({ code: "RESUME_REDUCED", detail: "复评结论为降量恢复，恢复后首场先降低负荷观察" });
        return { participant_id, state: PARTICIPANT_STATES.REDUCE_OBSERVE, reasons, advice, assessed_at };
      }
    }

    for (const rule of this.#rules.values()) {
      if (evaluateCondition(rule.condition, facts)) {
        advice.push({ rule_id: rule.rule_id, action: rule.action, description: rule.description });
      }
    }
    const stopAdvice = advice.filter((a) => a.action === "STOP");
    if (stopAdvice.length > 0) {
      reasons.push({ code: "RULE_STOP", detail: `审核规则建议停止：${stopAdvice.map((a) => a.description || a.rule_id).join("；")}` });
      return { participant_id, state: PARTICIPANT_STATES.PAUSE_HANDOFF, reasons, advice, assessed_at };
    }

    const reduceAdvice = advice.filter((a) => a.action === "REDUCE" || a.action === "CONSULT");
    if (reduceAdvice.length > 0) {
      reasons.push({ code: "RULE_ADVICE", detail: `审核规则提示：${reduceAdvice.map((a) => a.description || a.rule_id).join("；")}` });
    }
    if (facts.pending_device_anomalies > 0) {
      reasons.push({ code: "DEVICE_ANOMALY_PENDING", detail: `有 ${facts.pending_device_anomalies} 条异常设备值未确认，确认前不加量并降量观察` });
    }
    if (facts.last_rpe != null && facts.last_rpe >= 8) {
      reasons.push({ code: "HIGH_RPE", detail: `最近主观疲劳感受 RPE=${facts.last_rpe}，偏高` });
    }
    if (facts.medical_max_sessions_per_week != null && facts.sessions_last_7d >= facts.medical_max_sessions_per_week) {
      reasons.push({ code: "MEDICAL_LIMIT", detail: `近 7 天已参加 ${facts.sessions_last_7d} 场，达到医生范围上限 ${facts.medical_max_sessions_per_week} 场` });
    }
    if (session && ((session.temperature_c ?? 0) >= 32 || (session.humidity_pct ?? 0) >= 85)) {
      reasons.push({ code: "VENUE_HEAT", detail: `场地温度 ${session.temperature_c}℃、湿度 ${session.humidity_pct}%，建议降低负荷` });
    }
    if (reasons.length > 0) {
      return { participant_id, state: PARTICIPANT_STATES.REDUCE_OBSERVE, reasons, advice, assessed_at };
    }
    reasons.push({ code: "WITHIN_LIMITS", detail: "负荷、主观感受、异常信号与场地条件均在医生参与范围和当前计划内" });
    return { participant_id, state: PARTICIPANT_STATES.CONTINUE, reasons, advice, assessed_at };
  }

  #facts(p, session) {
    const history = this.#trustedHistory(p.participant_id);
    const weekAgo = this.#now().getTime() - 7 * 24 * 3600 * 1000;
    const last7 = history.filter((r) => Date.parse(r.recorded_at) >= weekAgo);
    const last = history[history.length - 1] ?? null;
    return {
      temperature_c: session?.temperature_c ?? null,
      humidity_pct: session?.humidity_pct ?? null,
      last_rpe: last?.rpe ?? null,
      last_avg_hr: last?.avg_hr ?? null,
      sessions_last_7d: last7.length,
      load_minutes_last_7d: last7.reduce((sum, r) => sum + (r.duration_min ?? 0), 0),
      medical_max_sessions_per_week: p.medical_scope?.max_sessions_per_week ?? null,
      medical_max_heart_rate: p.medical_scope?.max_heart_rate ?? null,
      pending_device_anomalies: this.#pendingAnomalies(p.participant_id).length,
      unhandled_red_flags: p.signals.filter((s) => RED_FLAG_SET.has(s.signal) && !s.handled).length,
      self_reported_risk_count: p.self_reported_risks.length,
      movement_caution_count: p.movement_assessment?.cautions?.length ?? 0,
      baseline_activity_level: p.baseline_activity.level,
    };
  }

  #pendingAnomalies(participantId) {
    return [...this.#loadRecords.values()].filter((r) => r.participant_id === participantId && r.status === "PENDING_CONFIRMATION");
  }

  /** 可信负荷历史：重传与重复去重后，每场取优先级最高的已确认记录；异常未确认不计入。 */
  #trustedHistory(participantId) {
    const bySession = new Map();
    for (const rec of this.#loadRecords.values()) {
      if (rec.participant_id !== participantId || rec.status !== "CONFIRMED") continue;
      const list = bySession.get(rec.session_id) ?? [];
      list.push(rec);
      bySession.set(rec.session_id, list);
    }
    const trusted = [];
    for (const list of bySession.values()) {
      list.sort((a, b) => SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source));
      trusted.push(list[0]);
    }
    trusted.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
    return trusted;
  }

  // ---------- 角色视图：各取所需，最小可见 ----------

  /** 教练视图：仅带课必要信息（分组、目标负荷、动作注意、当前状态、是否被抢占）。 */
  coachView(session_id) {
    const session = this.#session(session_id);
    const participants = [];
    for (const [pid, slot] of session.records) {
      const p = this.#participants.get(pid);
      if (!p) continue;
      const plan = this.#currentPlan(p);
      const assessment = this.assess(pid, session_id);
      participants.push({
        participant_id: pid,
        display_name: p.display_name,
        group: plan?.group ?? null,
        target_load: plan?.target_load ?? null,
        state: assessment.state,
        cautions: p.movement_assessment?.cautions ?? [],
        preempted: slot.preempted,
      });
    }
    return {
      session_id: session.session_id,
      site_id: session.site_id,
      scheduled_at: session.scheduled_at,
      temperature_c: session.temperature_c,
      humidity_pct: session.humidity_pct,
      participants,
    };
  }

  /** 参与者视图：公开状态依据，让本人明白状态从哪里来。 */
  participantView(participant_id) {
    const p = this.#participant(participant_id);
    const assessment = this.assess(participant_id);
    const plan = this.#currentPlan(p);
    const nextReview = p.reviews.find((r) => r.status === "scheduled") ?? null;
    return {
      participant_id,
      display_name: p.display_name,
      goals: p.goals,
      state: assessment.state,
      reasons: assessment.reasons,
      advice: assessment.advice,
      plan: plan && { version: plan.version, group: plan.group, weekly_sessions: plan.weekly_sessions, target_load: plan.target_load },
      next_review: nextReview && { due_at: nextReview.due_at, reviewer: nextReview.reviewer },
    };
  }

  /** 医生复评视图：可信负荷历史（去重、冲突标注、异常未确认不计入）与暂停复评轨迹。 */
  doctorView(participant_id) {
    const p = this.#participant(participant_id);
    const load_history = this.#trustedHistory(participant_id).map((rec) => ({
      record_id: rec.record_id,
      session_id: rec.session_id,
      source: rec.source,
      recorded_at: rec.recorded_at,
      duration_min: rec.duration_min,
      avg_hr: rec.avg_hr,
      distance_km: rec.distance_km,
      rpe: rec.rpe,
      plan_version: rec.plan_version,
      conflict: rec.conflict,
    }));
    return {
      participant_id,
      medical_scope: p.medical_scope,
      movement_assessment: p.movement_assessment,
      load_history,
      pending_confirmation: this.#pendingAnomalies(participant_id).map((r) => ({
        record_id: r.record_id,
        session_id: r.session_id,
        source: r.source,
        anomalies: r.anomalies,
      })),
      pauses: p.pauses.map((x) => ({ ...x })),
      reviews: p.reviews.map((x) => ({ ...x })),
      signals: p.signals.map((x) => ({ ...x })),
      handoffs: p.handoffs.map((x) => ({ ...x })),
    };
  }

  /** 运营视图：仅去标识聚合结果，用于评估安全性，不含任何参与者标识。 */
  operatorStats() {
    const byState = { CONTINUE: 0, REDUCE_OBSERVE: 0, PAUSE_HANDOFF: 0 };
    for (const pid of this.#participants.keys()) {
      byState[this.assess(pid).state] += 1;
    }
    let attendance_total = 0;
    let absence_total = 0;
    for (const s of this.#sessions.values()) {
      for (const slot of s.records.values()) {
        if (slot.attendance) attendance_total += 1;
        if (slot.absence) absence_total += 1;
      }
    }
    const participants = [...this.#participants.values()];
    return {
      participants_total: participants.length,
      sessions_total: this.#sessions.size,
      by_state: byState,
      attendance_total,
      absence_total,
      red_flag_total: participants.flatMap((p) => p.signals).filter((s) => RED_FLAG_SET.has(s.signal)).length,
      handoff_total: participants.reduce((n, p) => n + p.handoffs.length, 0),
      pause_open_total: participants.flatMap((p) => p.pauses).filter((x) => !x.lifted_by).length,
      device_anomaly_pending_total: [...this.#loadRecords.values()].filter((r) => r.status === "PENDING_CONFIRMATION").length,
    };
  }
}

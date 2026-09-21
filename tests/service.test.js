import assert from "node:assert/strict";
import test from "node:test";

import { RiskHandoffService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";

const T0 = "2026-09-21T08:00:00+08:00";

function makeService() {
  return new RiskHandoffService({ now: () => new Date(T0) });
}

/** 登记一位慢病老人：本人目标、基础活动水平、自报风险、医生范围、动作评估、分组计划。 */
function seed(svc, id = "p-001") {
  svc.registerParticipant({
    participant_id: id,
    display_name: "王阿姨",
    goals: { text: "改善心肺功能", target_sessions_per_week: 3 },
    baseline_activity: { level: 2, daily_steps: 3000 },
    self_reported_risks: [{ kind: "hypertension", note: "自报高血压，服药控制中" }],
  });
  svc.recordMedicalScope(id, {
    issued_by: "dr-li",
    max_sessions_per_week: 3,
    max_heart_rate: 150,
    restrictions: ["避免冲刺"],
  });
  svc.recordMovementAssessment(id, { assessor: "coach-chen", result: "pass", cautions: ["注意膝部落地"] });
  svc.approvePlan({ participant_id: id, group: "A组", weekly_sessions: 3, target_load: 30, decided_by: "coach-chen" });
  return id;
}

function makeSession(svc, id = "s-1", overrides = {}) {
  svc.createSession({
    session_id: id,
    site_id: "site-a",
    scheduled_at: "2026-09-21T09:00:00+08:00",
    temperature_c: 26,
    humidity_pct: 60,
    coach_id: "coach-chen",
    ...overrides,
  });
  return id;
}

test("状态可解释：资料齐全且无风险信号时可继续，并给出依据", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  const a = svc.assess("p-001", "s-1");
  assert.equal(a.state, "CONTINUE");
  assert.ok(a.reasons.length > 0);
  assert.equal(a.reasons[0].code, "WITHIN_LIMITS");
});

test("降量观察：主观疲劳偏高或场地高温高湿时给出可解释依据", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 110, rpe: 9 });
  const a = svc.assess("p-001", "s-1");
  assert.equal(a.state, "REDUCE_OBSERVE");
  assert.ok(a.reasons.some((r) => r.code === "HIGH_RPE"));

  const svc2 = makeService();
  seed(svc2);
  makeSession(svc2, "s-hot", { temperature_c: 34, humidity_pct: 88 });
  const a2 = svc2.assess("p-001", "s-hot");
  assert.equal(a2.state, "REDUCE_OBSERVE");
  assert.ok(a2.reasons.some((r) => r.code === "VENUE_HEAT"));
});

test("红旗信号：人工处置抢占普通课程、记录交接并暂停，复评后降量恢复", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  svc.recordAttendance({ session_id: "s-1", participant_id: "p-001", submission_id: "att-1" });
  svc.reportSignal({ participant_id: "p-001", session_id: "s-1", signal: "chest_pain", note: "主诉胸痛", reported_by: "coach-chen" });

  // 暂停并交接专业人员
  const a = svc.assess("p-001", "s-1");
  assert.equal(a.state, "PAUSE_HANDOFF");
  assert.ok(a.reasons.some((r) => r.code === "PAUSE_ACTIVE"));
  assert.ok(a.reasons.some((r) => r.code === "HANDOFF_RECORDED"));

  // 教练视图：该参与者被人工处置抢占
  const coach = svc.coachView("s-1");
  assert.equal(coach.participants[0].preempted, true);

  // 交接与暂停轨迹
  const doctor = svc.doctorView("p-001");
  assert.equal(doctor.handoffs.length, 1);
  assert.equal(doctor.handoffs[0].signal, "chest_pain");
  assert.equal(doctor.pauses.length, 1);

  // 事件顺序：先交接，后暂停
  const types = svc.events().map((e) => e.event_type);
  assert.ok(types.indexOf("HANDOFF_RECORDED") > -1);
  assert.ok(types.indexOf("HANDOFF_RECORDED") < types.indexOf("ACTIVITY_PAUSED"));

  // 复评：降量恢复 → 恢复后首场先降量观察
  const review = svc.scheduleReview("p-001", { reviewer: "dr-li", due_at: "2026-09-28T09:00:00+08:00" });
  svc.completeReview("p-001", review.review_id, { outcome: "resume_reduced", note: "复评通过，降量恢复" });
  const after = svc.assess("p-001");
  assert.equal(after.state, "REDUCE_OBSERVE");
  assert.ok(after.reasons.some((r) => r.code === "RESUME_REDUCED"));
});

test("规则必须经审核，且只能提示咨询、降量或停止", () => {
  const svc = makeService();
  seed(svc);
  assert.throws(
    () => svc.registerRule({ rule_id: "r-1", condition: { fact: "last_rpe", op: ">=", value: 8 }, action: "REDUCE" }),
    /审核/,
  );
  assert.throws(
    () =>
      svc.registerRule({
        rule_id: "r-2",
        condition: { fact: "last_rpe", op: ">=", value: 8 },
        action: "DIAGNOSE",
        reviewed_by: "dr-li",
        reviewed_at: "2026-09-20",
      }),
    /咨询、降量或停止/,
  );
  assert.throws(
    () =>
      svc.registerRule({
        rule_id: "r-3",
        condition: { fact: "password", op: "==", value: 1 },
        action: "REDUCE",
        reviewed_by: "dr-li",
        reviewed_at: "2026-09-20",
      }),
    /事实字段/,
  );
});

test("审核规则触发：降量建议映射降量观察，停止建议映射暂停交接", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  svc.registerRule({
    rule_id: "r-reduce",
    description: "RPE≥8 建议降量",
    condition: { fact: "last_rpe", op: ">=", value: 8 },
    action: "REDUCE",
    reviewed_by: "dr-li",
    reviewed_at: "2026-09-20",
  });
  svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 110, rpe: 9 });
  const a = svc.assess("p-001", "s-1");
  assert.equal(a.state, "REDUCE_OBSERVE");
  assert.ok(a.advice.some((x) => x.rule_id === "r-reduce"));

  const svc2 = makeService();
  seed(svc2);
  makeSession(svc2);
  svc2.registerRule({
    rule_id: "r-stop",
    description: "近7天达到医生上限即建议停止",
    condition: { fact: "sessions_last_7d", op: ">=", value: 1 },
    action: "STOP",
    reviewed_by: "dr-li",
    reviewed_at: "2026-09-20",
  });
  svc2.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "manual_checkin", submission_id: "m-1", duration_min: 30, avg_hr: 100, rpe: 4 });
  const a2 = svc2.assess("p-001", "s-1");
  assert.equal(a2.state, "PAUSE_HANDOFF");
  assert.ok(a2.reasons.some((r) => r.code === "RULE_STOP"));
});

test("异常设备值确认前不得加量，更正确认后计入可信历史", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  const rec = svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 260, rpe: 5 });
  assert.equal(rec.status, "PENDING_CONFIRMATION");

  // 确认前不得加量
  assert.throws(
    () => svc.approvePlan({ participant_id: "p-001", group: "A组", weekly_sessions: 3, target_load: 40, decided_by: "coach-chen" }),
    /异常设备值/,
  );
  const a = svc.assess("p-001", "s-1");
  assert.equal(a.state, "REDUCE_OBSERVE");
  assert.ok(a.reasons.some((r) => r.code === "DEVICE_ANOMALY_PENDING"));

  // 医生视图：可信历史为空，待确认一条
  let doctor = svc.doctorView("p-001");
  assert.equal(doctor.load_history.length, 0);
  assert.equal(doctor.pending_confirmation.length, 1);

  // 人工更正确认：产生后继记录，原记录不回写
  const confirmed = svc.confirmLoad({ record_id: rec.record_id, confirmed_by: "coach-chen", corrected: { avg_hr: 126 } });
  assert.equal(confirmed.status, "CONFIRMED");
  doctor = svc.doctorView("p-001");
  assert.equal(doctor.load_history.length, 1);
  assert.equal(doctor.load_history[0].avg_hr, 126);
  assert.equal(doctor.pending_confirmation.length, 0);

  // 确认后允许加量
  const plan = svc.approvePlan({ participant_id: "p-001", group: "A组", weekly_sessions: 3, target_load: 40, decided_by: "coach-chen" });
  assert.equal(plan.target_load, 40);
});

test("计划变化从下一场生效，既往轨迹不回写", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc, "s-1");
  svc.recordLoad({
    session_id: "s-1",
    participant_id: "p-001",
    source: "wearable",
    submission_id: "w-1",
    duration_min: 30,
    avg_hr: 110,
    rpe: 5,
    recorded_at: "2026-09-21T09:30:00+08:00",
  });
  svc.approvePlan({ participant_id: "p-001", group: "B组", weekly_sessions: 2, target_load: 20, decided_by: "coach-chen", note: "降量" });
  makeSession(svc, "s-2", { scheduled_at: "2026-09-23T09:00:00+08:00" });
  svc.recordLoad({
    session_id: "s-2",
    participant_id: "p-001",
    source: "wearable",
    submission_id: "w-2",
    duration_min: 20,
    avg_hr: 105,
    rpe: 4,
    recorded_at: "2026-09-23T09:30:00+08:00",
  });

  const doctor = svc.doctorView("p-001");
  assert.equal(doctor.load_history[0].plan_version, 1);
  assert.equal(doctor.load_history[1].plan_version, 2);
  assert.equal(svc.participantView("p-001").plan.version, 2);
});

test("缺席、跨点参加与网络重传只累计一次", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc, "s-1", { site_id: "site-a" });
  makeSession(svc, "s-2", { site_id: "site-b" }); // 同日另一场地

  // 网络重传：同一 submission_id 重复提交
  const first = svc.recordAttendance({ session_id: "s-1", participant_id: "p-001", submission_id: "att-1" });
  const retry = svc.recordAttendance({ session_id: "s-1", participant_id: "p-001", submission_id: "att-1" });
  assert.equal(first.counted, true);
  assert.equal(retry.deduped, true);
  assert.equal(retry.dedup_reason, "retransmission");

  // 跨点参加：同日另一场地只累计一次
  const cross = svc.recordAttendance({ session_id: "s-2", participant_id: "p-001", submission_id: "att-2" });
  assert.equal(cross.deduped, true);
  assert.equal(cross.dedup_reason, "cross_site");

  // 缺席重复上报只累计一次
  svc.recordAbsence({ session_id: "s-2", participant_id: "p-001", submission_id: "abs-1" });
  const absDup = svc.recordAbsence({ session_id: "s-2", participant_id: "p-001", submission_id: "abs-2" });
  assert.equal(absDup.deduped, true);

  const stats = svc.operatorStats();
  assert.equal(stats.attendance_total, 1);
  assert.equal(stats.absence_total, 1);

  // 负荷记录重传也只计入一次
  svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 110, rpe: 5 });
  const dup = svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 110, rpe: 5 });
  assert.equal(dup.deduped, true);
  assert.equal(svc.doctorView("p-001").load_history.length, 1);
});

test("多源矛盾记录：按优先级采信并标注冲突，医生看到可信历史", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 118, rpe: 5 });
  svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "self_report", submission_id: "sr-1", duration_min: 60, avg_hr: 95, rpe: 3 });
  const doctor = svc.doctorView("p-001");
  assert.equal(doctor.load_history.length, 1);
  assert.equal(doctor.load_history[0].source, "wearable");
  assert.equal(doctor.load_history[0].conflict, true);
});

test("视图按角色裁剪：教练只看带课必要信息，运营只看去标识结果", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  svc.recordAttendance({ session_id: "s-1", participant_id: "p-001", submission_id: "att-1" });

  const coach = svc.coachView("s-1");
  const entry = coach.participants[0];
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["cautions", "display_name", "group", "participant_id", "preempted", "state", "target_load"].sort(),
  );

  const participant = svc.participantView("p-001");
  assert.equal(participant.state, "CONTINUE");
  assert.ok(participant.reasons.length > 0);

  const stats = svc.operatorStats();
  const raw = JSON.stringify(stats);
  assert.ok(!raw.includes("p-001"));
  assert.ok(!raw.includes("王阿姨"));
  assert.equal(stats.participants_total, 1);
});

test("全流程事件均符合领域约定，版本按聚合递增", () => {
  const svc = makeService();
  seed(svc);
  makeSession(svc);
  svc.registerRule({
    rule_id: "r-1",
    description: "RPE≥8 建议降量",
    condition: { fact: "last_rpe", op: ">=", value: 8 },
    action: "REDUCE",
    reviewed_by: "dr-li",
    reviewed_at: "2026-09-20",
  });
  svc.recordAttendance({ session_id: "s-1", participant_id: "p-001", submission_id: "att-1" });
  svc.recordLoad({ session_id: "s-1", participant_id: "p-001", source: "wearable", submission_id: "w-1", duration_min: 30, avg_hr: 110, rpe: 6 });
  svc.reportSignal({ participant_id: "p-001", session_id: "s-1", signal: "joint_pain", note: "右膝不适", reported_by: "coach-chen" });
  svc.pause("p-001", { decided_by: "coach-chen", reason: "膝部不适，暂停观察" });
  const review = svc.scheduleReview("p-001", { reviewer: "dr-li", due_at: "2026-09-28T09:00:00+08:00" });
  svc.completeReview("p-001", review.review_id, { outcome: "resume_reduced" });

  const events = svc.events();
  assert.ok(events.length >= 10);
  for (const e of events) {
    assert.deepEqual(validateEvent(e), [], `事件应符合约定：${e.event_type}`);
  }
  const versions = events.filter((e) => e.aggregate_type === "participant_profile").map((e) => e.version);
  assert.deepEqual(versions, [1, 2, 3]);
});

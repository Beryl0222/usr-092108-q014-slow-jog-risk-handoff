import assert from "node:assert/strict";
import test from "node:test";

import { addSession, makeService, registerAndPlan } from "./helpers.js";

test("场次保存场地温湿度", () => {
  const { service } = makeService();
  addSession(service, "s-1", { venue: { temperature_c: 31, humidity_pct: 78 } });
  assert.deepEqual(service.session.get("s-1").venue, { temperature_c: 31, humidity_pct: 78 });
});

test("网络重传只累计一次", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  const first = service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-1",
  });
  const retry = service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-1",
  });
  assert.equal(first.outcome, "recorded");
  assert.equal(retry.outcome, "duplicate_retransmission");
  assert.equal(service.session.participationCount("p-1"), 1);
  assert.equal(service.session.dedupStats().retransmission_duplicates, 1);
});

test("同一日历日跨点参加只累计一次", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1", { site_id: "社区中心", scheduled_at: "2026-09-21T09:30:00+08:00" });
  addSession(service, "s-2", { site_id: "滨河公园", scheduled_at: "2026-09-21T19:00:00+08:00" });
  service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-1",
  });
  const second = service.session.recordAttendance({
    session_id: "s-2",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-2",
  });
  assert.equal(second.outcome, "cross_site_duplicate");
  assert.equal(service.session.participationCount("p-1"), 1);
  assert.equal(service.session.dedupStats().cross_site_duplicates, 1);
});

test("出席与缺席矛盾时不静默覆盖，需显式更正", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "absent",
    source: "manual_checkin",
    record_id: "rec-1",
  });
  const conflict = service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-2",
  });
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.kept.status, "absent");

  service.session.correctAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-3",
    supersedes: "rec-1",
    reason: "签到表补登",
  });
  assert.equal(service.session.effectiveAttendance("s-1", "p-1").status, "present");
});

test("缺席者出现负荷记录：暂不计入，确认后生效", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "absent",
    source: "manual_checkin",
    record_id: "rec-1",
  });
  const load = service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "wearable",
    record_id: "rec-2",
    metrics: { duration_min: 35, avg_heart_rate: 118 },
  });
  assert.equal(load.outcome, "absent_conflict");
  assert.equal(service.session.effectiveLoad("s-1", "p-1").status, "excluded");

  service.session.confirmLoad({
    session_id: "s-1",
    participant_id: "p-1",
    metrics: { duration_min: 35, avg_heart_rate: 118 },
    resolved_by: "staff-1",
    note: "本人确实到场，签到漏记",
  });
  assert.equal(service.session.effectiveLoad("s-1", "p-1").status, "confirmed");
});

test("多源负荷互相矛盾时标记冲突，确认前不参与累计", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "wearable",
    record_id: "rec-1",
    metrics: { duration_min: 40, avg_heart_rate: 120 },
  });
  service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "self_report",
    record_id: "rec-2",
    metrics: { duration_min: 10, avg_heart_rate: 120 },
  });
  const effective = service.session.effectiveLoad("s-1", "p-1");
  assert.equal(effective.status, "conflicted");
  assert.equal(effective.metrics, null);

  service.session.confirmLoad({
    session_id: "s-1",
    participant_id: "p-1",
    metrics: { duration_min: 40, avg_heart_rate: 120 },
    resolved_by: "staff-1",
  });
  assert.equal(service.session.effectiveLoad("s-1", "p-1").status, "confirmed");
  const history = service.session.loadHistory("p-1");
  assert.equal(history.length, 1);
  assert.equal(history[0].sources.length, 2, "历史保留全部来源，供医生判断");
});

test("多源一致时按可信度优先级取有效负荷", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "self_report",
    record_id: "rec-1",
    metrics: { duration_min: 38 },
  });
  service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "wearable",
    record_id: "rec-2",
    metrics: { duration_min: 40 },
  });
  const effective = service.session.effectiveLoad("s-1", "p-1");
  assert.equal(effective.status, "reported");
  assert.equal(effective.metrics.duration_min, 40, "一致时优先采用穿戴设备");
});

test("主观感受校验 RPE 范围", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  assert.throws(
    () =>
      service.session.recordFeedback({
        session_id: "s-1",
        participant_id: "p-1",
        rpe: 11,
        pain: false,
        symptoms: [],
      }),
    /rpe/,
  );
  service.session.recordFeedback({
    session_id: "s-1",
    participant_id: "p-1",
    rpe: 7,
    pain: true,
    symptoms: ["膝盖不适"],
  });
  assert.equal(service.session.lastFeedbackBefore("p-1", 99).rpe, 7);
});

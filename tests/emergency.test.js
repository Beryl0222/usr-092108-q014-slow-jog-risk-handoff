import assert from "node:assert/strict";
import test from "node:test";

import { addSession, makeService, registerAndPlan } from "./helpers.js";

function setupSession(service) {
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-1",
  });
}

test("胸痛出现时人工处置抢占普通课程并记录交接", () => {
  const { service } = makeService();
  setupSession(service);

  const handoff = service.risk.declareEmergency({
    participant_id: "p-1",
    session_id: "s-1",
    kind: "chest_pain",
    handled_by: "coach-1",
    handoff_to: "社区医院急诊科",
    note: "课程第 10 分钟主诉胸痛",
  });

  // 交接记录完整，且标记抢占了普通课程。
  assert.equal(handoff.preempted_session, true);
  assert.equal(handoff.handoff_to, "社区医院急诊科");
  assert.equal(handoff.session_id, "s-1");

  // 场次投影登记事故，普通课程对该参与者中断。
  const session = service.session.get("s-1");
  assert.equal(session.incidents.length, 1);
  assert.equal(session.incidents[0].participant_id, "p-1");

  // 立即暂停并安排复评。
  assert.ok(service.risk.pauseActive("p-1"));
  assert.ok(service.risk.openReview("p-1"));

  // 之后的判定只能是暂停并交给专业人员。
  const decision = service.risk.triage({ participant_id: "p-1", session_id: "s-1" });
  assert.equal(decision.status, "PAUSE_AND_REFER");

  // 教练视角看到该参与者已交接。
  const roster = service.coachRoster("s-1");
  assert.equal(roster[0].interrupted, true);
});

test("紧急处置仅适用于胸痛、眩晕、急性损伤", () => {
  const { service } = makeService();
  setupSession(service);
  assert.throws(
    () =>
      service.risk.declareEmergency({
        participant_id: "p-1",
        session_id: "s-1",
        kind: "other",
        handled_by: "coach-1",
        handoff_to: "社区医院",
      }),
    /紧急处置仅适用于/,
  );
});

test("复评完成后解除暂停并了结异常信号", () => {
  const { service } = makeService();
  setupSession(service);
  service.risk.declareEmergency({
    participant_id: "p-1",
    session_id: "s-1",
    kind: "dizziness",
    handled_by: "coach-1",
    handoff_to: "社区医院",
  });
  assert.ok(service.risk.pauseActive("p-1"));

  service.risk.completeReview({
    participant_id: "p-1",
    reviewer: "dr 复评医生",
    outcome: "可恢复参与，范围不变",
  });
  assert.equal(service.risk.pauseActive("p-1"), false);
  assert.equal(service.risk.openReview("p-1"), null);
  assert.ok(service.risk.flags("p-1").every((flag) => flag.resolved));

  addSession(service, "s-2", { scheduled_at: "2026-09-28T09:30:00+08:00" });
  const decision = service.risk.triage({ participant_id: "p-1", session_id: "s-2" });
  assert.equal(decision.status, "CONTINUE");
});

test("暂停与复评轨迹全部留痕", () => {
  const { service } = makeService();
  setupSession(service);
  service.risk.declareEmergency({
    participant_id: "p-1",
    session_id: "s-1",
    kind: "acute_injury",
    handled_by: "coach-1",
    handoff_to: "运动医学门诊",
  });
  const events = service.store.byAggregate("clinical_handoff", "p-1");
  assert.deepEqual(
    events.map((e) => e.event_type),
    ["ACTIVITY_PAUSED", "HANDOFF_RECORDED", "REVIEW_SCHEDULED"],
  );
});

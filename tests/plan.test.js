import assert from "node:assert/strict";
import test from "node:test";

import { addSession, makeService, registerAndPlan } from "./helpers.js";

test("登记保存本人目标、基础活动水平与自报风险", () => {
  const { service } = makeService();
  service.plan.registerParticipant({
    participant_id: "p-1",
    display_name: "王女士",
    goals: ["减重", "改善睡眠"],
    baseline_activity: "sedentary",
    self_reported_risks: ["高血压"],
    recent_acute_injury: null,
  });
  const profile = service.plan.profile("p-1");
  assert.deepEqual(profile.goals, ["减重", "改善睡眠"]);
  assert.equal(profile.baseline_activity, "sedentary");
  assert.deepEqual(profile.self_reported_risks, ["高血压"]);
});

test("医生参与范围与动作评估被保存且保留历史", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  service.plan.recordPhysicianScope({
    participant_id: "p-1",
    max_heart_rate: 120,
    max_duration_min: 40,
    restrictions: ["避免憋气"],
    valid_until: "2026-12-31",
    issued_by: "dr-li",
  });
  service.plan.recordPhysicianScope({
    participant_id: "p-1",
    max_heart_rate: 125,
    max_duration_min: 45,
    restrictions: [],
    valid_until: "2027-03-31",
    issued_by: "dr-li",
  });
  service.plan.recordMovementAssessment({
    participant_id: "p-1",
    items: [{ name: "深蹲", result: "ok" }],
    concerns: ["膝内扣"],
    assessor: "coach-1",
  });
  assert.equal(service.plan.scopeHistory("p-1").length, 2);
  assert.equal(service.plan.latestScope("p-1").max_heart_rate, 125);
  assert.deepEqual(service.plan.latestAssessment("p-1").concerns, ["膝内扣"]);
});

test("分组计划不得超出医生参与范围", () => {
  const { service } = makeService();
  service.plan.registerParticipant({
    participant_id: "p-1",
    goals: ["健康"],
    baseline_activity: "light",
    self_reported_risks: ["糖尿病"],
    recent_acute_injury: null,
  });
  service.plan.recordPhysicianScope({
    participant_id: "p-1",
    max_heart_rate: 120,
    max_duration_min: 40,
    restrictions: [],
    valid_until: "2027-01-01",
    issued_by: "dr-li",
  });
  assert.throws(
    () =>
      service.plan.approvePlan({
        participant_id: "p-1",
        group: "A组",
        target_duration_min: 60,
        target_heart_rate: 110,
        approved_by: "coach-1",
      }),
    /不得超出医生给出的参与范围/,
  );
});

test("计划变化从下一场生效，既往轨迹不回写", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1", { target_duration_min: 30 });
  // 首版计划在所有场次之前批准，自第 1 场生效。
  assert.equal(service.plan.planHistory("p-1").at(-1).effective_from_session_seq, 1);

  addSession(service, "s-1", { scheduled_at: "2026-09-14T09:30:00+08:00" });
  addSession(service, "s-2", { scheduled_at: "2026-09-21T09:30:00+08:00" });

  // 第 2 场尚未开始（在未来），新计划自下一场（第 2 场）生效。
  service.plan.approvePlan({
    participant_id: "p-1",
    group: "A组",
    level: "L2",
    target_duration_min: 40,
    target_heart_rate: 135,
    approved_by: "coach-1",
  });
  const v2 = service.plan.planHistory("p-1").at(-1);
  assert.equal(v2.plan_version, 2);
  assert.equal(v2.effective_from_session_seq, 2);

  // 既往场次仍按当时版本，不回写。
  assert.equal(service.plan.planForSession("p-1", 1).plan_version, 1);
  assert.equal(service.plan.planForSession("p-1", 1).target_duration_min, 30);
  assert.equal(service.plan.planForSession("p-1", 2).plan_version, 2);
});

test("异常设备值确认前不得加量", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1", { target_duration_min: 30 });
  service.risk.flagRisk({
    participant_id: "p-1",
    kind: "abnormal_device_value",
    detail: "设备报告心率 210，疑似异常",
    source: "wearable",
  });
  assert.throws(
    () =>
      service.plan.approvePlan({
        participant_id: "p-1",
        group: "A组",
        target_duration_min: 45,
        target_heart_rate: 130,
        approved_by: "coach-1",
      }),
    /确认前不得加量/,
  );

  // 确认读数无效后可以加量。
  const flag = service.risk.flags("p-1")[0];
  service.risk.resolveDeviceReading({
    participant_id: "p-1",
    flag_id: flag.flag_id,
    resolution: "confirmed_invalid",
    resolved_by: "staff-1",
  });
  const approved = service.plan.approvePlan({
    participant_id: "p-1",
    group: "A组",
    target_duration_min: 45,
    target_heart_rate: 130,
    approved_by: "coach-1",
  });
  assert.equal(approved.plan_version, 2);
});

test("未登记参与者不能批准计划", () => {
  const { service } = makeService();
  assert.throws(
    () =>
      service.plan.approvePlan({
        participant_id: "ghost",
        group: "A组",
        target_duration_min: 30,
        target_heart_rate: 120,
        approved_by: "coach-1",
      }),
    /尚未登记/,
  );
});

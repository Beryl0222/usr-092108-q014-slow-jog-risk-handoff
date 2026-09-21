import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRiskHandoffService } from "../src/service.js";
import { addSession, makeService, registerAndPlan } from "./helpers.js";

function triage(service, pid, sid) {
  return service.risk.triage({ participant_id: pid, session_id: sid });
}

test("健康且条件正常：可以按当前计划继续", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "CONTINUE");
  assert.equal(decision.reasons.length, 0);
  assert.deepEqual(decision.constraints, { max_duration_min: 30, max_heart_rate: 130 });
});

test("判定结果可解释：理由带规则标识与中文说明", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1", { venue: { temperature_c: 33, humidity_pct: 85 } });
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "REDUCE_AND_OBSERVE");
  assert.ok(decision.reasons.length > 0);
  for (const reason of decision.reasons) {
    assert.ok(reason.rule_id.startsWith("R-"));
    assert.ok(reason.summary.length > 0);
  }
  assert.ok(decision.constraints.max_duration_min < 30, "降量后时长上限应收紧");
});

test("高温高湿触发降量观察", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1", { venue: { temperature_c: 29, humidity_pct: 82 } });
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "REDUCE_AND_OBSERVE");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-HEAT"));
});

test("上次主观感受过强触发降量", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1", { scheduled_at: "2026-09-14T09:30:00+08:00" });
  service.session.recordFeedback({
    session_id: "s-1",
    participant_id: "p-1",
    rpe: 9,
    pain: false,
    symptoms: [],
  });
  addSession(service, "s-2");
  const decision = triage(service, "p-1", "s-2");
  assert.equal(decision.status, "REDUCE_AND_OBSERVE");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-RPE-HIGH"));
});

test("负荷突增触发降量", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  for (const [sid, date, minutes] of [
    ["s-1", "2026-09-07T09:30:00+08:00", 30],
    ["s-2", "2026-09-14T09:30:00+08:00", 30],
    ["s-3", "2026-09-18T09:30:00+08:00", 50],
  ]) {
    addSession(service, sid, { scheduled_at: date });
    service.session.recordLoad({
      session_id: sid,
      participant_id: "p-1",
      source: "wearable",
      record_id: `rec-${sid}`,
      metrics: { duration_min: minutes },
    });
  }
  addSession(service, "s-4");
  const decision = triage(service, "p-1", "s-4");
  assert.equal(decision.status, "REDUCE_AND_OBSERVE");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-LOAD-SPIKE"));
});

test("久坐上班族初始阶段降量观察", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1", { baseline_activity: "sedentary" });
  addSession(service, "s-1");
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "REDUCE_AND_OBSERVE");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-SEDENTARY-START"));
});

test("慢病老人缺少医生参与范围：暂停并交给专业人员", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1", { self_reported_risks: ["高血压", "冠心病"] });
  addSession(service, "s-1");
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "PAUSE_AND_REFER");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-SCOPE-MISSING"));
  assert.equal(decision.constraints, null);
});

test("医生参与范围过期：暂停待复评", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1", {
    self_reported_risks: ["高血压"],
    scope: {
      max_heart_rate: 125,
      max_duration_min: 40,
      restrictions: [],
      valid_until: "2026-09-01T00:00:00+08:00",
      issued_by: "dr-li",
    },
    target_duration_min: 30,
    target_heart_rate: 120,
  });
  addSession(service, "s-1");
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "PAUSE_AND_REFER");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-SCOPE-EXPIRED"));
});

test("近期急性伤情：暂停并交给专业人员", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1", {
    recent_acute_injury: { description: "踝关节扭伤", occurred_on: "2026-09-10" },
  });
  addSession(service, "s-1");
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "PAUSE_AND_REFER");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-ACUTE-INJURY-RECENT"));
});

test("未解决的胸痛信号：暂停并交给专业人员", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.risk.flagRisk({
    participant_id: "p-1",
    kind: "chest_pain",
    detail: "晨起胸闷",
    source: "self_report",
  });
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "PAUSE_AND_REFER");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-RED-FLAG-UNRESOLVED"));
});

test("未确认异常设备值：降量且不得加量", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  service.risk.flagRisk({
    participant_id: "p-1",
    kind: "abnormal_device_value",
    detail: "心率读数 220",
    source: "wearable",
  });
  const decision = triage(service, "p-1", "s-1");
  assert.equal(decision.status, "REDUCE_AND_OBSERVE");
  assert.ok(decision.reasons.some((r) => r.rule_id === "R-DEVICE-UNCONFIRMED"));
});

test("重新判定追加记录，既往判定不回写", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1");
  const first = triage(service, "p-1", "s-1");
  assert.equal(first.status, "CONTINUE");
  service.risk.flagRisk({
    participant_id: "p-1",
    kind: "dizziness",
    detail: "昨夜眩晕",
    source: "self_report",
  });
  const second = triage(service, "p-1", "s-1");
  assert.equal(second.status, "PAUSE_AND_REFER");
  const events = service.store
    .byAggregate("risk_observation", "p-1")
    .filter((e) => e.event_type === "TRIAGE_DECIDED");
  assert.equal(events.length, 2, "两次判定都保留在事件轨迹中");
  assert.equal(events[0].payload.status, "CONTINUE");
});

test("未经审核的规则集不得启用", () => {
  assert.throws(
    () => createRiskHandoffService({ ruleSet: { rule_set_id: "x" } }),
    /审核字段/,
  );
  // 篡改动作：规则只能提示咨询、降量或停止，越界动作在加载时即被拒绝。
  const tampered = JSON.parse(
    readFileSync(new URL("../data/rules.approved.json", import.meta.url), "utf8"),
  );
  tampered.rules.find((r) => r.id === "R-HEAT").action = "DIAGNOSE_DISEASE";
  assert.throws(() => createRiskHandoffService({ ruleSet: tampered }), /超出允许范围/);
});

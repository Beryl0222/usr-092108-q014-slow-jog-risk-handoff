import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addSession, makeService, registerAndPlan } from "./helpers.js";

function setupFull(service, pid, group) {
  registerAndPlan(service, pid, {
    self_reported_risks: ["高血压"],
    scope: {
      max_heart_rate: 125,
      max_duration_min: 40,
      restrictions: [],
      valid_until: "2027-06-30",
      issued_by: "dr-li",
    },
    group,
    target_duration_min: 30,
    target_heart_rate: 120,
  });
}

test("教练只看带课必要信息", () => {
  const { service } = makeService();
  setupFull(service, "p-1", "A组");
  addSession(service, "s-1");
  service.session.recordAttendance({
    session_id: "s-1",
    participant_id: "p-1",
    status: "present",
    source: "manual_checkin",
    record_id: "rec-1",
  });
  service.risk.triage({ participant_id: "p-1", session_id: "s-1" });

  const roster = service.coachRoster("s-1");
  assert.equal(roster.length, 1);
  const row = roster[0];
  assert.deepEqual(
    Object.keys(row).sort(),
    ["display_name", "group", "intensity_cap", "interrupted", "participant_id", "status", "status_label"],
  );
  const serialized = JSON.stringify(roster);
  for (const forbidden of ["self_reported_risks", "高血压", "scope", "assessment", "goals", "restrictions"]) {
    assert.ok(!serialized.includes(forbidden), `教练视图不应包含 ${forbidden}`);
  }
  assert.equal(row.status, "CONTINUE");
  assert.deepEqual(row.intensity_cap, { max_duration_min: 30, max_heart_rate: 120 });
});

test("参与者看到自己的状态依据", () => {
  const { service } = makeService();
  registerAndPlan(service, "p-1");
  addSession(service, "s-1", { venue: { temperature_c: 33, humidity_pct: 60 } });
  service.risk.triage({ participant_id: "p-1", session_id: "s-1" });

  const view = service.participantStatus("p-1");
  assert.equal(view.status, "REDUCE_AND_OBSERVE");
  assert.equal(view.status_label, "先降低负荷观察");
  assert.ok(view.reasons.length > 0);
  assert.ok(view.reasons[0].summary.includes("温"));
  assert.ok(view.plan.group);
});

test("医生复评获得可信负荷历史（含来源与确认状态）", () => {
  const { service } = makeService();
  setupFull(service, "p-1", "A组");
  addSession(service, "s-1", { scheduled_at: "2026-09-14T09:30:00+08:00" });
  service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "wearable",
    record_id: "rec-1",
    metrics: { duration_min: 40, avg_heart_rate: 118 },
  });
  service.session.recordLoad({
    session_id: "s-1",
    participant_id: "p-1",
    source: "self_report",
    record_id: "rec-2",
    metrics: { duration_min: 15 },
  });
  service.session.confirmLoad({
    session_id: "s-1",
    participant_id: "p-1",
    metrics: { duration_min: 40, avg_heart_rate: 118 },
    resolved_by: "staff-1",
  });

  const view = service.physicianHistory("p-1");
  assert.equal(view.profile.self_reported_risks[0], "高血压");
  assert.equal(view.scope_history.length, 1);
  assert.equal(view.load_history.length, 1);
  const entry = view.load_history[0];
  assert.equal(entry.status, "confirmed");
  assert.equal(entry.sources.length, 2, "矛盾来源都保留，供医生判断");
  assert.equal(entry.confirmed_by, "staff-1");
});

test("运营方报表去标识，小样本分组隐藏", () => {
  const { service } = makeService();
  // 5 名 A 组 + 2 名 B 组参与者。
  for (let i = 1; i <= 5; i += 1) {
    registerAndPlan(service, `p-a${i}`, { group: "A组" });
  }
  for (let i = 1; i <= 2; i += 1) {
    registerAndPlan(service, `p-b${i}`, { group: "B组" });
  }
  addSession(service, "s-1");
  for (const pid of ["p-a1", "p-a2", "p-a3", "p-a4", "p-a5", "p-b1", "p-b2"]) {
    service.session.recordAttendance({
      session_id: "s-1",
      participant_id: pid,
      status: "present",
      source: "manual_checkin",
      record_id: `rec-${pid}`,
    });
    service.risk.triage({ participant_id: pid, session_id: "s-1" });
  }
  service.risk.pause({ participant_id: "p-a1", reason: "规则建议停止", decided_by: "staff-1" });

  const report = service.operatorSafetyReport({ from: "2026-09-01", to: "2026-10-01" });
  assert.equal(report.sessions, 1);
  assert.equal(report.unique_participants, 7);
  assert.equal(report.attendance.present, 7);
  assert.equal(report.triage_distribution.CONTINUE, 7);
  assert.equal(report.pause_count, 1);
  assert.deepEqual(report.by_group["A组"], { participants: 5 });
  assert.equal(report.by_group["B组"], "样本量不足，已隐藏");

  const serialized = JSON.stringify(report);
  for (const pid of ["p-a1", "p-a2", "p-a3", "p-a4", "p-a5", "p-b1", "p-b2"]) {
    assert.ok(!serialized.includes(pid), `运营方报表不得包含参与者标识 ${pid}`);
  }
});

test("持久化重放后视图与判定历史保持一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "sj-service-"));
  const file = join(dir, "events.jsonl");
  const first = makeService({ filePath: file });
  registerAndPlan(first.service, "p-1");
  addSession(first.service, "s-1");
  first.service.risk.triage({ participant_id: "p-1", session_id: "s-1" });

  const second = makeService({ filePath: file });
  assert.equal(second.service.plan.planHistory("p-1").length, 1);
  assert.equal(second.service.risk.triageHistory("p-1").length, 1);
  assert.equal(second.service.participantStatus("p-1").status, "CONTINUE");
});

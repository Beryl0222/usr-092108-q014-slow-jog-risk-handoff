import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

const base = {
  event_id: "e-1",
  event_type: "PLAN_APPROVED",
  aggregate_type: "participant_plan",
  aggregate_id: "a-1",
  occurred_at: "2026-09-21T08:00:00+08:00",
  version: 1,
  summary: "测试事件",
};

test("合法事件通过校验", () => {
  assert.deepEqual(validateEvent(base), []);
});

test("缺字段、版本非法、未知类型、非法时间被拒绝", () => {
  const { event_id, ...missing } = base;
  assert.ok(validateEvent(missing).some((e) => e.includes("event_id")));
  assert.ok(validateEvent({ ...base, version: 0 }).some((e) => e.includes("version")));
  assert.ok(validateEvent({ ...base, event_type: "HACK" }).some((e) => e.includes("事件类型")));
  assert.ok(validateEvent({ ...base, aggregate_type: "unknown" }).some((e) => e.includes("聚合类型")));
  assert.ok(validateEvent({ ...base, occurred_at: "not-a-date" }).some((e) => e.includes("occurred_at")));
  assert.ok(validateEvent({ ...base, summary: "" }).some((e) => e.includes("summary")));
});

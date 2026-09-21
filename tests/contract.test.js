import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_AGGREGATE, EVENT_TYPES } from "../src/event-types.js";
import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("契约与代码常量保持一致", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"),
  );
  const eventEnum = schema.properties.event_type.enum;
  const aggregateEnum = schema.properties.aggregate_type.enum;
  assert.deepEqual([...eventEnum].sort(), [...EVENT_TYPES].sort(), "事件类型枚举需与 src/event-types.js 同步");
  assert.deepEqual(
    [...aggregateEnum].sort(),
    [...AGGREGATE_TYPES].sort(),
    "聚合类型枚举需与 src/event-types.js 同步",
  );
  for (const type of EVENT_TYPES) {
    assert.ok(EVENT_AGGREGATE[type], `事件 ${type} 缺少聚合映射`);
  }
});

test("信封校验拒绝非法记录", () => {
  assert.ok(validateEvent(null).length > 0);
  assert.ok(validateEvent({}).length > 0);
  const bad = {
    event_id: "e1",
    event_type: "NOT_A_TYPE",
    aggregate_type: "participant_plan",
    aggregate_id: "p1",
    occurred_at: "not-a-time",
    version: 0,
    summary: "x",
  };
  const errors = validateEvent(bad);
  assert.ok(errors.some((e) => e.includes("未知事件类型")));
  assert.ok(errors.some((e) => e.includes("occurred_at")));
  assert.ok(errors.some((e) => e.includes("version")));
});

test("事件类型与聚合类型必须匹配", () => {
  const mismatch = {
    event_id: "e2",
    event_type: "PLAN_APPROVED",
    aggregate_type: "activity_session",
    aggregate_id: "s1",
    occurred_at: "2026-09-21T08:00:00+08:00",
    version: 1,
    summary: "聚合不匹配",
  };
  assert.ok(validateEvent(mismatch).some((e) => e.includes("聚合")));
});

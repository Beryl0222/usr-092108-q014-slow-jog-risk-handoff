import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore } from "../src/store/event-store.js";

function envelope(overrides = {}) {
  return {
    event_id: "e-1",
    event_type: "PLAN_APPROVED",
    aggregate_type: "participant_plan",
    aggregate_id: "p-1",
    occurred_at: "2026-09-21T08:00:00+08:00",
    version: 1,
    summary: "测试事件",
    ...overrides,
  };
}

test("版本必须连续，不允许跳号或重放", () => {
  const store = new EventStore({});
  store.append(envelope());
  assert.throws(() => store.append(envelope({ event_id: "e-2", version: 1 })), /下一版本应为 2/);
  assert.throws(() => store.append(envelope({ event_id: "e-3", version: 3 })), /下一版本应为 2/);
  store.append(envelope({ event_id: "e-2", version: 2 }));
  assert.equal(store.byAggregate("participant_plan", "p-1").length, 2);
});

test("非法信封被拒绝", () => {
  const store = new EventStore({});
  assert.throws(() => store.append({ event_id: "x" }), /不符合领域约定/);
});

test("事件接收后冻结，不提供改写入口", () => {
  const store = new EventStore({});
  const saved = store.append(envelope());
  assert.ok(Object.isFrozen(saved));
  assert.equal(typeof store.update, "undefined");
  assert.equal(typeof store.delete, "undefined");
});

test("JSONL 持久化后可重放，状态一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "sj-store-"));
  const file = join(dir, "events.jsonl");
  const store = new EventStore({ filePath: file });
  store.append(envelope());
  store.append(envelope({ event_id: "e-2", version: 2, summary: "后继更正", supersedes: "e-1" }));

  const reloaded = EventStore.loadFrom(file);
  assert.equal(reloaded.all().length, 2);
  assert.equal(reloaded.nextVersion("participant_plan", "p-1"), 3);
  assert.equal(reloaded.all()[1].supersedes, "e-1");
});

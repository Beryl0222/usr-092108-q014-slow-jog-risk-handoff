import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { validateEvent } from "../validator.js";

/**
 * 追加式事件存储。
 *
 * 事件一旦被接收，其标识、发生时间和版本不允许原地改写或删除；
 * 业务更正（如签到纠错）必须产生带有 supersedes 的后继事件。
 * 每个聚合（aggregate_type + aggregate_id）的版本号必须连续递增。
 */
export class EventStore {
  #events = [];
  #versions = new Map();
  #filePath;

  constructor({ filePath } = {}) {
    this.#filePath = filePath ?? null;
  }

  static keyOf(aggregateType, aggregateId) {
    return `${aggregateType}/${aggregateId}`;
  }

  /** 该聚合下一个合法版本号。 */
  nextVersion(aggregateType, aggregateId) {
    return (this.#versions.get(EventStore.keyOf(aggregateType, aggregateId)) ?? 0) + 1;
  }

  /**
   * 接收一条事件。校验信封与版本连续性，成功后冻结对象并按需落盘。
   * @returns 被冻结存储的事件对象。
   */
  append(event) {
    return this.#ingest(event, true);
  }

  #ingest(event, persist) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      throw new Error(`事件不符合领域约定：${errors.join("；")}`);
    }
    const key = EventStore.keyOf(event.aggregate_type, event.aggregate_id);
    const expected = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new Error(
        `聚合 ${key} 的下一版本应为 ${expected}，收到 ${event.version}；` +
          "不允许跳号、重放或原地改写，业务更正请产生后继事件",
      );
    }
    const frozen = Object.freeze({ ...event });
    this.#events.push(frozen);
    this.#versions.set(key, event.version);
    if (persist && this.#filePath) {
      appendFileSync(this.#filePath, `${JSON.stringify(event)}\n`, "utf8");
    }
    return frozen;
  }

  /** 全部事件，按接收顺序。 */
  all() {
    return [...this.#events];
  }

  byAggregate(aggregateType, aggregateId) {
    const key = EventStore.keyOf(aggregateType, aggregateId);
    return this.#events.filter(
      (event) => EventStore.keyOf(event.aggregate_type, event.aggregate_id) === key,
    );
  }

  /** 从 JSONL 文件重放历史事件（重放同样校验，但不重复写盘）。 */
  static loadFrom(filePath) {
    const store = new EventStore({ filePath });
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      for (const line of lines) {
        store.#ingest(JSON.parse(line), false);
      }
    }
    return store;
  }
}

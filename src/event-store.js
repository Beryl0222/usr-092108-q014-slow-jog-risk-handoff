import { appendFileSync } from "node:fs";

/**
 * 追加式事件存储：事件一旦被接收，其标识、发生时间和版本不被原地改写；
 * 业务更正（如异常设备值确认）产生后继记录。网络重传按 event_id 去重。
 */
export class EventStore {
  #events = [];
  #ids = new Set();
  #sink;

  constructor({ sink } = {}) {
    this.#sink = sink ?? null;
  }

  /** 追加事件；若 event_id 已存在（网络重传），返回 null 表示忽略，不重复累计。 */
  append(event) {
    if (this.#ids.has(event.event_id)) return null;
    this.#ids.add(event.event_id);
    this.#events.push(event);
    this.#sink?.(event);
    return event;
  }

  has(eventId) {
    return this.#ids.has(eventId);
  }

  all() {
    return [...this.#events];
  }

  byAggregate(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }
}

/** JSONL 落盘 sink：每条事件追加一行，服务重启前的事件留有轨迹。 */
export function jsonlSink(filePath) {
  return (event) => appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

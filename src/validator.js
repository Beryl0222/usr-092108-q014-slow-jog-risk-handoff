import { AGGREGATE_TYPES, EVENT_AGGREGATE, EVENT_TYPES } from "./event-types.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/**
 * 校验领域事件信封，返回错误列表（空数组表示通过）。
 * 只负责基础约定；各事件载荷的业务校验由对应领域服务完成。
 */
export function validateEvent(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);

  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (
    "occurred_at" in record &&
    (typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at)))
  ) {
    errors.push("occurred_at 必须是可解析的时间字符串");
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) {
    errors.push("summary 必须是非空字符串");
  }
  if (
    "event_type" in record &&
    "aggregate_type" in record &&
    EVENT_TYPES.includes(record.event_type) &&
    AGGREGATE_TYPES.includes(record.aggregate_type) &&
    EVENT_AGGREGATE[record.event_type] !== record.aggregate_type
  ) {
    errors.push(`事件 ${record.event_type} 应属于聚合 ${EVENT_AGGREGATE[record.event_type]}`);
  }
  if ("supersedes" in record && typeof record.supersedes !== "string") {
    errors.push("supersedes 必须是字符串（被更正事件的 event_id）");
  }
  return errors;
}

import { readFileSync } from "node:fs";

/** 契约文件是事件信封的单一事实源：必填字段与枚举都以它为准。 */
const schema = JSON.parse(readFileSync(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const required = schema.required;
const eventTypes = new Set(schema.properties.event_type.enum);
const aggregateTypes = new Set(schema.properties.aggregate_type.enum);

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !eventTypes.has(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !aggregateTypes.has(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是有效的日期时间");
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) errors.push("summary 必须是非空字符串");
  return errors;
}

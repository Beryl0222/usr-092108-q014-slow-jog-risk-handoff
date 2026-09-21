import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { EVENT_AGGREGATE } from "./event-types.js";
import { EventStore } from "./store/event-store.js";
import { loadApprovedRuleSet } from "./rules/triage-rules.js";
import { PlanService } from "./services/plan-service.js";
import { SessionService } from "./services/session-service.js";
import { RiskService } from "./services/risk-service.js";
import {
  coachRoster,
  operatorSafetyReport,
  participantStatus,
  physicianHistory,
} from "./services/views.js";

/**
 * 风险接力服务门面：把事件存储、三个领域服务与分角色视图接线为一个整体。
 *
 * @param {object} options
 * @param {string} [options.filePath] JSONL 事件日志路径；提供时先重放历史事件。
 * @param {() => string} [options.clock] 时钟（默认当前时间，测试可注入固定时间）。
 * @param {object} [options.ruleSet] 经审核的规则集（默认读取 data/rules.approved.json）。
 */
export function createRiskHandoffService(options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const store = options.filePath ? EventStore.loadFrom(options.filePath) : new EventStore({});
  const ruleSet = loadApprovedRuleSet(
    options.ruleSet ??
      JSON.parse(readFileSync(new URL("../data/rules.approved.json", import.meta.url), "utf8")),
  );

  const services = [];
  const emit = (eventType, aggregateId, payload, summary, extra = {}) => {
    const aggregateType = EVENT_AGGREGATE[eventType];
    const event = {
      event_id: randomUUID(),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: clock(),
      version: store.nextVersion(aggregateType, aggregateId),
      summary,
      payload,
      ...extra,
    };
    store.append(event);
    for (const service of services) {
      service.apply(event);
    }
    return event;
  };

  const plan = new PlanService({ emit });
  const session = new SessionService({ emit });
  const risk = new RiskService({ emit, clock, ruleSet, plan, session });
  services.push(plan, session, risk);

  // 跨聚合约束：异常设备值确认前不得加量；计划变化从下一场生效。
  plan.bindHooks({
    hasUnconfirmedDeviceAbnormal: (participantId) => risk.hasUnconfirmedDeviceAbnormal(participantId),
    upcomingSessionSeq: () => session.upcomingSessionSeq(clock()),
  });

  // 重放历史事件，重建全部投影。
  for (const event of store.all()) {
    for (const service of services) {
      service.apply(event);
    }
  }

  const viewDeps = { plan, session, risk };

  return {
    store,
    plan,
    session,
    risk,
    // 分角色视图
    coachRoster: (sessionId) => coachRoster(viewDeps, sessionId),
    participantStatus: (participantId, sessionId = null) =>
      participantStatus(viewDeps, participantId, sessionId),
    physicianHistory: (participantId) => physicianHistory(viewDeps, participantId),
    operatorSafetyReport: (range) => operatorSafetyReport(viewDeps, range),
  };
}

import { createRiskHandoffService } from "../src/service.js";

export const NOW = "2026-09-21T08:00:00+08:00";

/** 固定时钟的服务实例；setNow 可推进时间。 */
export function makeService(overrides = {}) {
  let now = overrides.now ?? NOW;
  const service = createRiskHandoffService({ clock: () => now, ...overrides });
  return {
    service,
    setNow(value) {
      now = value;
    },
  };
}

/** 登记一名健康、规律活动的参与者并批准首版计划。 */
export function registerAndPlan(service, participantId, overrides = {}) {
  service.plan.registerParticipant({
    participant_id: participantId,
    display_name: overrides.display_name ?? participantId,
    goals: ["改善心肺"],
    baseline_activity: overrides.baseline_activity ?? "regular",
    self_reported_risks: overrides.self_reported_risks ?? [],
    recent_acute_injury: overrides.recent_acute_injury ?? null,
  });
  if (overrides.scope) {
    service.plan.recordPhysicianScope({ participant_id: participantId, ...overrides.scope });
  }
  if (overrides.assessment) {
    service.plan.recordMovementAssessment({ participant_id: participantId, ...overrides.assessment });
  }
  service.plan.approvePlan({
    participant_id: participantId,
    group: overrides.group ?? "A组",
    level: "L1",
    target_duration_min: overrides.target_duration_min ?? 30,
    target_heart_rate: overrides.target_heart_rate ?? 130,
    approved_by: "coach-1",
  });
}

/** 登记一个场次。 */
export function addSession(service, sessionId, overrides = {}) {
  return service.session.recordSession({
    session_id: sessionId,
    site_id: overrides.site_id ?? "社区中心",
    scheduled_at: overrides.scheduled_at ?? "2026-09-21T09:30:00+08:00",
    venue: overrides.venue ?? { temperature_c: 25, humidity_pct: 50 },
  });
}

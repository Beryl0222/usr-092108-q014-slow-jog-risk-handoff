import { TRIAGE_STATUS_LABEL } from "../rules/triage-rules.js";

/** 运营方报表中小样本隐藏的阈值。 */
const MIN_GROUP_SIZE = 5;

/**
 * 分角色视图。调用方只读取完成职责所必需的字段：
 * - 教练：只看带课必要信息（分组、当日状态、强度上限、是否已交接）；
 * - 参与者：看到自己的状态与依据；
 * - 医生：复评所需的完整可信负荷历史（含来源与确认状态）；
 * - 运营方：仅去标识的聚合结果，小样本隐藏。
 */

function capFrom(plan, scope) {
  if (!plan) {
    return null;
  }
  return {
    max_duration_min: scope ? Math.min(plan.target_duration_min, scope.max_duration_min) : plan.target_duration_min,
    max_heart_rate: scope ? Math.min(plan.target_heart_rate, scope.max_heart_rate) : plan.target_heart_rate,
  };
}

/** 教练视角：某场次的带课名单，仅含必要字段。 */
export function coachRoster({ plan, session, risk }, sessionId) {
  const found = session.get(sessionId);
  if (!found) {
    throw new Error(`场次不存在：${sessionId}`);
  }
  const roster = [];
  for (const [participantId, attendance] of found.attendance) {
    if (attendance.status !== "present" || attendance.cross_site_duplicate) {
      continue;
    }
    const profile = plan.profile(participantId);
    const triage = risk.latestTriage(participantId, sessionId);
    const planVersion = plan.planForSession(participantId, found.seq);
    const scope = plan.latestScope(participantId);
    roster.push({
      participant_id: participantId,
      display_name: profile?.display_name ?? participantId,
      group: planVersion?.group ?? "未分组",
      status: triage?.status ?? "UNASSESSED",
      status_label: triage ? TRIAGE_STATUS_LABEL[triage.status] : "未评估",
      intensity_cap: triage?.constraints ?? capFrom(planVersion, scope),
      interrupted: found.incidents.some((incident) => incident.participant_id === participantId),
    });
  }
  return roster;
}

/** 参与者视角：自己的状态与依据。 */
export function participantStatus({ plan, risk }, participantId, sessionId = null) {
  const profile = plan.profile(participantId);
  if (!profile) {
    throw new Error(`参与者尚未登记：${participantId}`);
  }
  const triageList = risk.triageHistory(participantId);
  const latest =
    (sessionId ? triageList.find((item) => item.session_id === sessionId) : null) ?? triageList.at(-1) ?? null;
  const openReview = risk.openReview(participantId);
  const currentPlan = plan.planHistory(participantId).at(-1) ?? null;
  return {
    participant_id: participantId,
    status: latest?.status ?? "UNASSESSED",
    status_label: latest ? TRIAGE_STATUS_LABEL[latest.status] : "尚未评估",
    reasons: latest?.reasons ?? [],
    advisories: latest?.advisories ?? [],
    constraints: latest?.constraints ?? null,
    plan: currentPlan
      ? {
          group: currentPlan.group,
          level: currentPlan.level,
          target_duration_min: currentPlan.target_duration_min,
          target_heart_rate: currentPlan.target_heart_rate,
          effective_from_session_seq: currentPlan.effective_from_session_seq,
        }
      : null,
    next_review_due: openReview?.due_before ?? null,
    decided_at: latest?.decided_at ?? null,
  };
}

/** 医生视角：复评所需的完整记录与可信负荷历史（含来源与确认状态）。 */
export function physicianHistory({ plan, session, risk }, participantId) {
  const profile = plan.profile(participantId);
  if (!profile) {
    throw new Error(`参与者尚未登记：${participantId}`);
  }
  return {
    participant_id: participantId,
    profile,
    scope_history: plan.scopeHistory(participantId),
    assessment: plan.latestAssessment(participantId),
    plan_history: plan.planHistory(participantId),
    load_history: session.loadHistory(participantId),
    flags: risk.flags(participantId),
    pauses: risk.pauses(participantId),
    handoffs: risk.handoffs(participantId),
    reviews: risk.reviews(participantId),
    triage_history: risk.triageHistory(participantId),
  };
}

/**
 * 运营方视角：去标识的安全性聚合报表。
 * 不包含任何参与者标识；不足 MIN_GROUP_SIZE 的分组拆分被隐藏。
 */
export function operatorSafetyReport({ plan, session, risk }, { from, to }) {
  const sessions = session.sessionsInRange(from, to);
  const sessionIds = new Set(sessions.map((item) => item.session_id));

  const participants = new Set();
  let present = 0;
  let absent = 0;
  const triageDistribution = { CONTINUE: 0, REDUCE_AND_OBSERVE: 0, PAUSE_AND_REFER: 0 };
  const redFlagCounts = {};
  let pauseCount = 0;
  let handoffCount = 0;
  const groupOf = new Map();

  for (const participantId of plan.participantIds()) {
    groupOf.set(participantId, plan.planHistory(participantId).at(-1)?.group ?? "未分组");
    for (const triage of risk.triageHistory(participantId)) {
      if (sessionIds.has(triage.session_id)) {
        triageDistribution[triage.status] += 1;
      }
    }
    for (const flag of risk.flags(participantId)) {
      if (flag.occurred_at >= from && flag.occurred_at <= to) {
        redFlagCounts[flag.kind] = (redFlagCounts[flag.kind] ?? 0) + 1;
      }
    }
    pauseCount += risk
      .pauses(participantId)
      .filter((pause) => pause.paused_at >= from && pause.paused_at <= to).length;
    handoffCount += risk
      .handoffs(participantId)
      .filter((handoff) => sessionIds.has(handoff.session_id)).length;
  }

  for (const item of sessions) {
    for (const [participantId, attendance] of item.attendance) {
      if (attendance.status === "present" && !attendance.cross_site_duplicate) {
        present += 1;
        participants.add(participantId);
      } else if (attendance.status === "absent") {
        absent += 1;
      }
    }
  }

  // 分组拆分：不足阈值的分组隐藏，避免可识别的小样本。
  const groupBuckets = new Map();
  for (const participantId of participants) {
    const group = groupOf.get(participantId) ?? "未分组";
    groupBuckets.set(group, (groupBuckets.get(group) ?? 0) + 1);
  }
  const byGroup = {};
  for (const [group, count] of groupBuckets) {
    byGroup[group] = count >= MIN_GROUP_SIZE ? { participants: count } : "样本量不足，已隐藏";
  }

  const dedup = session.dedupStats();
  return {
    range: { from, to },
    sessions: sessions.length,
    unique_participants: participants.size,
    attendance: {
      present,
      absent,
      duplicates_ignored: dedup.retransmission_duplicates + dedup.cross_site_duplicates,
    },
    triage_distribution: triageDistribution,
    pause_count: pauseCount,
    emergency_handoffs: handoffCount,
    red_flag_counts: redFlagCounts,
    by_group: byGroup,
  };
}

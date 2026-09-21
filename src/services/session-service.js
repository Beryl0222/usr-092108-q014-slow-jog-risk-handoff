import { LOAD_SOURCE_PRIORITY, LOAD_SOURCES } from "../event-types.js";

/** 多源负荷差异超过该比例即视为冲突。 */
const DURATION_CONFLICT_RATIO = 1.2;
/** 平均心率差异超过该值即视为冲突。 */
const HEART_RATE_CONFLICT_DELTA = 15;

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少或非法字段：${field}`);
  }
  return value;
}

function dateOf(isoString) {
  // 场次时间均带本地时区偏移，按日历日截取即可满足“同日跨点”判断。
  return isoString.slice(0, 10);
}

/**
 * 场次服务：场地温湿度、出席、每次负荷、主观感受。
 *
 * 去重约定（缺席、跨点参加、网络重传只能累计一次）：
 * - 网络重传：来源方提供的 record_id 全局唯一，重复提交直接忽略；
 * - 跨点参加：同一参与者同一日历日在多个场次签到，仅首个场次计入，后续标记为跨点重复；
 * - 缺席与负荷冲突：标记缺席后又出现负荷记录（或反之），该负荷暂不计入，待人工确认。
 */
export class SessionService {
  #emit;
  #sessions = new Map();
  #seenRecordIds = new Set();
  #dayIndex = new Map(); // `${participant_id}|${date}` -> 首个签到场次
  #stats = { retransmission_duplicates: 0, cross_site_duplicates: 0, status_conflicts: 0 };
  #seqCounter = 0;

  constructor({ emit }) {
    this.#emit = emit;
  }

  #requireSession(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`场次不存在：${sessionId}`);
    }
    return session;
  }

  /** 登记场次与场地温湿度。 */
  recordSession({ session_id, site_id, scheduled_at, venue, note = null }) {
    requireString(session_id, "session_id");
    requireString(site_id, "site_id");
    requireString(scheduled_at, "scheduled_at");
    if (Number.isNaN(Date.parse(scheduled_at))) {
      throw new Error("scheduled_at 必须是可解析的时间字符串");
    }
    if (this.#sessions.has(session_id)) {
      throw new Error(`场次已存在：${session_id}`);
    }
    if (
      venue === null ||
      typeof venue !== "object" ||
      typeof venue.temperature_c !== "number" ||
      typeof venue.humidity_pct !== "number"
    ) {
      throw new Error("venue 必须包含 temperature_c 与 humidity_pct 数值");
    }
    const seq = this.#seqCounter + 1;
    const event = this.#emit("SESSION_RECORDED", session_id, {
      session_id,
      seq,
      site_id,
      scheduled_at,
      venue: { temperature_c: venue.temperature_c, humidity_pct: venue.humidity_pct },
      note,
    }, `登记场次 ${session_id}（${site_id}，${venue.temperature_c}℃/${venue.humidity_pct}%）`);
    return event.payload;
  }

  /**
   * 记录出席/缺席。
   * @returns {{outcome: string}} outcome ∈ recorded | duplicate_retransmission | duplicate_same_status | conflict | cross_site_duplicate
   */
  recordAttendance({ session_id, participant_id, status, source, record_id }) {
    const session = this.#requireSession(session_id);
    requireString(participant_id, "participant_id");
    if (!["present", "absent"].includes(status)) {
      throw new Error(`未知出席状态：${status}`);
    }
    if (!LOAD_SOURCES.includes(source)) {
      throw new Error(`未知记录来源：${source}`);
    }
    requireString(record_id, "record_id");

    if (this.#seenRecordIds.has(record_id)) {
      this.#stats.retransmission_duplicates += 1;
      return { outcome: "duplicate_retransmission" };
    }
    this.#seenRecordIds.add(record_id);

    const existing = session.attendance.get(participant_id);
    if (existing) {
      if (existing.status === status) {
        return { outcome: "duplicate_same_status" };
      }
      // 出席与缺席互相矛盾：保留先到的记录，冲突显式返回，由人工用 correctAttendance 更正。
      this.#stats.status_conflicts += 1;
      return { outcome: "conflict", kept: existing };
    }

    const dayKey = `${participant_id}|${dateOf(session.scheduled_at)}`;
    const firstSessionId = this.#dayIndex.get(dayKey);
    const crossSiteDuplicate = status === "present" && firstSessionId !== undefined && firstSessionId !== session_id;

    this.#emit("ATTENDANCE_RECORDED", session_id, {
      session_id,
      participant_id,
      status,
      source,
      record_id,
      cross_site_duplicate: crossSiteDuplicate,
    }, crossSiteDuplicate ? `跨点重复签到，仅首个场次累计：${participant_id}` : `记录出席：${participant_id} ${status}`);

    if (status === "present" && !crossSiteDuplicate && firstSessionId === undefined) {
      this.#dayIndex.set(dayKey, session_id);
    }
    if (crossSiteDuplicate) {
      this.#stats.cross_site_duplicates += 1;
    }
    return { outcome: crossSiteDuplicate ? "cross_site_duplicate" : "recorded" };
  }

  /** 出席纠错：产生带 supersedes 的后继事件，不原地改写。 */
  correctAttendance({ session_id, participant_id, status, source, record_id, supersedes, reason }) {
    const session = this.#requireSession(session_id);
    requireString(participant_id, "participant_id");
    if (!["present", "absent"].includes(status)) {
      throw new Error(`未知出席状态：${status}`);
    }
    requireString(record_id, "record_id");
    requireString(supersedes, "supersedes");
    requireString(reason, "reason");
    if (this.#seenRecordIds.has(record_id)) {
      throw new Error(`record_id 已被使用：${record_id}`);
    }
    if (!session.attendance.has(participant_id)) {
      throw new Error("没有可更正的出席记录");
    }
    this.#seenRecordIds.add(record_id);
    const event = this.#emit("ATTENDANCE_RECORDED", session_id, {
      session_id,
      participant_id,
      status,
      source,
      record_id,
      cross_site_duplicate: false,
      correction_reason: reason,
    }, `更正出席：${participant_id} → ${status}`, { supersedes });
    return event.payload;
  }

  /**
   * 记录一次负荷（穿戴设备 / 人工签到 / 本人补录）。
   * 多源数据互相矛盾时标记冲突；与缺席记录矛盾时暂不计入。
   */
  recordLoad({ session_id, participant_id, source, record_id, metrics }) {
    const session = this.#requireSession(session_id);
    requireString(participant_id, "participant_id");
    if (!LOAD_SOURCES.includes(source)) {
      throw new Error(`未知记录来源：${source}`);
    }
    requireString(record_id, "record_id");
    if (metrics === null || typeof metrics !== "object" || typeof metrics.duration_min !== "number" || metrics.duration_min < 0) {
      throw new Error("metrics 必须包含非负的 duration_min");
    }
    if (this.#seenRecordIds.has(record_id)) {
      this.#stats.retransmission_duplicates += 1;
      return { outcome: "duplicate_retransmission" };
    }
    this.#seenRecordIds.add(record_id);

    const attendance = session.attendance.get(participant_id);
    const absentConflict = attendance?.status === "absent";
    const event = this.#emit("LOAD_RECORDED", session_id, {
      session_id,
      participant_id,
      source,
      record_id,
      metrics: { ...metrics },
      absent_conflict: absentConflict,
    }, absentConflict ? `缺席者出现负荷记录，待确认：${participant_id}` : `记录负荷：${participant_id}（${source}）`);
    return { outcome: absentConflict ? "absent_conflict" : "recorded", payload: event.payload };
  }

  /** 确认某场次的有效负荷（消解多源冲突或缺席矛盾），确认前该负荷不参与加量判断。 */
  confirmLoad({ session_id, participant_id, metrics, resolved_by, note = null }) {
    const session = this.#requireSession(session_id);
    requireString(participant_id, "participant_id");
    requireString(resolved_by, "resolved_by");
    if (metrics === null || typeof metrics !== "object" || typeof metrics.duration_min !== "number" || metrics.duration_min < 0) {
      throw new Error("metrics 必须包含非负的 duration_min");
    }
    const entry = session.loads.get(participant_id);
    if (!entry || entry.records.length === 0) {
      throw new Error("没有待确认的负荷记录");
    }
    const event = this.#emit("LOAD_CONFIRMED", session_id, {
      session_id,
      participant_id,
      metrics: { ...metrics },
      resolved_by,
      note,
    }, `确认负荷：${participant_id} ${metrics.duration_min} 分钟`);
    return event.payload;
  }

  /** 记录主观感受（RPE、疼痛、症状）。 */
  recordFeedback({ session_id, participant_id, rpe, pain = false, symptoms = [], note = null }) {
    this.#requireSession(session_id);
    requireString(participant_id, "participant_id");
    if (!Number.isInteger(rpe) || rpe < 1 || rpe > 10) {
      throw new Error("rpe 必须是 1-10 的整数");
    }
    if (!Array.isArray(symptoms)) {
      throw new Error("symptoms 必须是数组");
    }
    const event = this.#emit("FEEDBACK_RECORDED", session_id, {
      session_id,
      participant_id,
      rpe,
      pain,
      symptoms: [...symptoms],
      note,
    }, `记录主观感受：${participant_id} RPE=${rpe}`);
    return event.payload;
  }

  // ---- 查询 ----

  get(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  latestSeq() {
    return this.#seqCounter;
  }

  /** 下一场未开始场次的序号；若都已开始则为最新序号 + 1。 */
  upcomingSessionSeq(nowIso) {
    let upcoming = null;
    for (const session of this.#sessions.values()) {
      if (session.scheduled_at > nowIso && (upcoming === null || session.seq < upcoming)) {
        upcoming = session.seq;
      }
    }
    return upcoming ?? this.#seqCounter + 1;
  }

  sessionsInRange(fromIso, toIso) {
    return [...this.#sessions.values()].filter(
      (session) => session.scheduled_at >= fromIso && session.scheduled_at <= toIso,
    );
  }

  /** 有效出席（present 且非跨点重复）。 */
  effectiveAttendance(sessionId, participantId) {
    const attendance = this.#sessions.get(sessionId)?.attendance.get(participantId);
    if (!attendance || attendance.status !== "present" || attendance.cross_site_duplicate) {
      return null;
    }
    return attendance;
  }

  /**
   * 某参与者某场次的有效负荷。
   * @returns {null | {status: "confirmed"|"reported"|"conflicted"|"excluded", metrics: object|null}}
   */
  effectiveLoad(sessionId, participantId) {
    const entry = this.#sessions.get(sessionId)?.loads.get(participantId);
    if (!entry) {
      return null;
    }
    if (entry.confirmed) {
      return { status: "confirmed", metrics: entry.confirmed.metrics };
    }
    if (entry.absent_conflict) {
      return { status: "excluded", metrics: null };
    }
    if (entry.conflict) {
      return { status: "conflicted", metrics: null };
    }
    const prioritized = [...entry.records].sort(
      (a, b) => LOAD_SOURCE_PRIORITY.indexOf(a.source) - LOAD_SOURCE_PRIORITY.indexOf(b.source),
    );
    return { status: "reported", metrics: prioritized[0].metrics };
  }

  /**
   * 参与者的负荷历史（含来源与确认状态），供医生复评的可信负荷轨迹。
   * 冲突未确认与缺席矛盾的记录保留在历史中但 metrics 为 null 并标明状态。
   */
  loadHistory(participantId, { beforeSeq = null } = {}) {
    const history = [];
    for (const session of [...this.#sessions.values()].sort((a, b) => a.seq - b.seq)) {
      if (beforeSeq !== null && session.seq >= beforeSeq) {
        continue;
      }
      const entry = session.loads.get(participantId);
      if (!entry) {
        continue;
      }
      const effective = this.effectiveLoad(session.session_id, participantId);
      history.push({
        session_id: session.session_id,
        seq: session.seq,
        scheduled_at: session.scheduled_at,
        site_id: session.site_id,
        status: effective.status,
        metrics: effective.metrics,
        sources: entry.records.map((record) => ({
          source: record.source,
          record_id: record.record_id,
          metrics: record.metrics,
        })),
        confirmed_by: entry.confirmed?.resolved_by ?? null,
      });
    }
    return history;
  }

  /** 某场次之前最近一次主观感受。 */
  lastFeedbackBefore(participantId, beforeSeq) {
    let latest = null;
    for (const session of this.#sessions.values()) {
      if (session.seq >= beforeSeq) {
        continue;
      }
      const feedback = session.feedback.get(participantId);
      if (feedback && (latest === null || session.seq > latest.seq)) {
        latest = { ...feedback, seq: session.seq, session_id: session.session_id };
      }
    }
    return latest;
  }

  /** 首次有效参与（非跨点重复的 present）的日期。 */
  firstParticipationDate(participantId) {
    let first = null;
    for (const session of this.#sessions.values()) {
      const attendance = session.attendance.get(participantId);
      if (attendance?.status === "present" && !attendance.cross_site_duplicate) {
        if (first === null || session.scheduled_at < first) {
          first = session.scheduled_at;
        }
      }
    }
    return first;
  }

  /** 有效参与次数（缺席、跨点重复、网络重传均只累计一次或不累计）。 */
  participationCount(participantId) {
    let count = 0;
    for (const session of this.#sessions.values()) {
      const attendance = session.attendance.get(participantId);
      if (attendance?.status === "present" && !attendance.cross_site_duplicate) {
        count += 1;
      }
    }
    return count;
  }

  dedupStats() {
    return { ...this.#stats };
  }

  // ---- 事件回放 ----

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "SESSION_RECORDED": {
        this.#sessions.set(payload.session_id, {
          session_id: payload.session_id,
          seq: payload.seq,
          site_id: payload.site_id,
          scheduled_at: payload.scheduled_at,
          venue: payload.venue,
          note: payload.note ?? null,
          attendance: new Map(),
          loads: new Map(),
          feedback: new Map(),
          incidents: [],
        });
        this.#seqCounter = Math.max(this.#seqCounter, payload.seq);
        break;
      }
      case "ATTENDANCE_RECORDED": {
        const session = this.#sessions.get(payload.session_id);
        if (!session) {
          break;
        }
        if (event.supersedes) {
          // 出席纠错：后继事件覆盖投影中的状态，历史事件本身不变。
          session.attendance.set(payload.participant_id, {
            status: payload.status,
            source: payload.source,
            record_id: payload.record_id,
            cross_site_duplicate: false,
            corrected: true,
            correction_reason: payload.correction_reason ?? null,
          });
          if (payload.status === "present") {
            this.#dayIndex.set(`${payload.participant_id}|${dateOf(session.scheduled_at)}`, payload.session_id);
          }
          break;
        }
        session.attendance.set(payload.participant_id, {
          status: payload.status,
          source: payload.source,
          record_id: payload.record_id,
          cross_site_duplicate: payload.cross_site_duplicate ?? false,
          corrected: false,
          correction_reason: null,
        });
        if (payload.status === "present" && !payload.cross_site_duplicate) {
          const dayKey = `${payload.participant_id}|${dateOf(session.scheduled_at)}`;
          if (!this.#dayIndex.has(dayKey)) {
            this.#dayIndex.set(dayKey, payload.session_id);
          }
        }
        break;
      }
      case "LOAD_RECORDED": {
        const session = this.#sessions.get(payload.session_id);
        if (!session) {
          break;
        }
        const entry = session.loads.get(payload.participant_id) ?? {
          records: [],
          confirmed: null,
          conflict: false,
          absent_conflict: false,
        };
        entry.records.push({
          source: payload.source,
          record_id: payload.record_id,
          metrics: payload.metrics,
        });
        entry.absent_conflict = entry.absent_conflict || (payload.absent_conflict ?? false);
        entry.conflict = this.#detectConflict(entry.records);
        session.loads.set(payload.participant_id, entry);
        break;
      }
      case "LOAD_CONFIRMED": {
        const session = this.#sessions.get(payload.session_id);
        const entry = session?.loads.get(payload.participant_id);
        if (entry) {
          entry.confirmed = { metrics: payload.metrics, resolved_by: payload.resolved_by, note: payload.note ?? null };
          entry.conflict = false;
          entry.absent_conflict = false;
        }
        break;
      }
      case "FEEDBACK_RECORDED": {
        const session = this.#sessions.get(payload.session_id);
        if (session) {
          session.feedback.set(payload.participant_id, {
            rpe: payload.rpe,
            pain: payload.pain,
            symptoms: payload.symptoms,
            note: payload.note ?? null,
          });
        }
        break;
      }
      case "HANDOFF_RECORDED": {
        // 人工处置抢占普通课程：场次投影登记事故，该参与者本次课程中断。
        const session = this.#sessions.get(payload.session_id);
        if (session) {
          session.incidents.push({
            participant_id: payload.participant_id,
            kind: payload.kind,
            handoff_id: payload.handoff_id,
            preempted_session: payload.preempted_session ?? true,
            occurred_at: event.occurred_at,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  #detectConflict(records) {
    if (records.length < 2) {
      return false;
    }
    const durations = records.map((record) => record.metrics.duration_min);
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);
    if (maxDuration > 0 && maxDuration / Math.max(minDuration, 1) > DURATION_CONFLICT_RATIO) {
      return true;
    }
    const heartRates = records
      .map((record) => record.metrics.avg_heart_rate)
      .filter((value) => typeof value === "number");
    if (heartRates.length >= 2 && Math.max(...heartRates) - Math.min(...heartRates) > HEART_RATE_CONFLICT_DELTA) {
      return true;
    }
    return false;
  }
}

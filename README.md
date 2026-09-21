# 超慢跑风险接力

社区健康中心在每次组织超慢跑前，把参与者落入三种可解释状态之一：**可以按当前计划继续 / 先降低负荷观察 / 暂停并交给专业人员**。本仓库实现该风险接力服务：从报名登记到每场判定、负荷记录、异常处置与复评的完整事件轨迹。

## 快速开始

```bash
node --test
```

```js
import { createRiskHandoffService } from "./src/service.js";

const service = createRiskHandoffService({ filePath: "data/events.jsonl" });

// 报名：本人目标、基础活动水平、自报风险、近期急性伤情
service.plan.registerParticipant({
  participant_id: "p-1",
  display_name: "王女士",
  goals: ["改善心肺"],
  baseline_activity: "sedentary", // sedentary | light | regular
  self_reported_risks: ["高血压"],
  recent_acute_injury: null,
});
// 医生参与范围、动作评估、分组计划（自下一场生效）
service.plan.recordPhysicianScope({ participant_id: "p-1", max_heart_rate: 125, max_duration_min: 40, restrictions: [], valid_until: "2027-03-31", issued_by: "dr-li" });
service.plan.recordMovementAssessment({ participant_id: "p-1", items: [], concerns: [], assessor: "coach-1" });
service.plan.approvePlan({ participant_id: "p-1", group: "A组", level: "L1", target_duration_min: 30, target_heart_rate: 120, approved_by: "coach-1" });

// 场次：场地温湿度、出席、每次负荷、主观感受
service.session.recordSession({ session_id: "s-1", site_id: "社区中心", scheduled_at: "2026-09-21T09:30:00+08:00", venue: { temperature_c: 31, humidity_pct: 78 } });
service.session.recordAttendance({ session_id: "s-1", participant_id: "p-1", status: "present", source: "manual_checkin", record_id: "rec-1" });
service.session.recordLoad({ session_id: "s-1", participant_id: "p-1", source: "wearable", record_id: "rec-2", metrics: { duration_min: 28, avg_heart_rate: 116 } });
service.session.recordFeedback({ session_id: "s-1", participant_id: "p-1", rpe: 6, pain: false, symptoms: [] });

// 每场前的三态判定（可解释）
const decision = service.risk.triage({ participant_id: "p-1", session_id: "s-1" });
// → { status: "REDUCE_AND_OBSERVE", reasons: [{ rule_id: "R-HEAT", summary: "场地温湿度偏高…" }], … }
```

## 结构

```
contracts/domain.schema.json   事件信封契约（与 src/event-types.js 由契约测试保持同步）
data/rules.approved.json       经审核的判定规则集（阈值与规则动作，含审核人/时间）
data/sample.json               中文样例记录
src/event-types.js             聚合、事件类型、信号种类等常量
src/validator.js               事件信封校验
src/store/event-store.js       追加式事件存储（JSONL 持久化、版本连续、不可改写）
src/rules/triage-rules.js      三态判定引擎与经审核规则
src/services/plan-service.js   目标、基础活动、自报风险、医生范围、动作评估、分组计划版本
src/services/session-service.js 场次与场地温湿度、出席去重、负荷冲突、主观感受
src/services/risk-service.js   异常信号、设备确认、三态判定、暂停、复评、紧急交接
src/services/views.js          教练 / 参与者 / 医生 / 运营方四种视图
src/service.js                 门面：接线、事件广播、历史重放
tests/                         node --test
```

## 领域规则

### 三态判定（可解释）

`risk.triage({ participant_id, session_id })` 依据经审核规则集输出 `CONTINUE` / `REDUCE_AND_OBSERVE` / `PAUSE_AND_REFER`，并附命中规则的中文理由（`reasons`）与咨询提示（`advisories`），参与者可据此明白状态依据。判定考虑：暂停与复评状态、未解决异常信号、近期急性伤情、医生参与范围（缺失/过期/将到期）、未确认异常设备值、场地温湿度、上次主观感受、负荷突增、动作评估顾虑、基础活动水平。

### 规则红线

- 规则动作只有三种：**提示咨询、降量、停止**；规则不诊断疾病，也不修改治疗。越界动作的规则集在加载时即被拒绝；未含审核记录（审核人、审核时间、版本）的规则不得启用。
- **异常设备值确认前不得自动加量**：判定至多维持降量观察，且 `plan.approvePlan` 直接拒绝提高目标；`risk.resolveDeviceReading` 确认后才解除。

### 计划版本

计划变化**从下一场生效**（`effective_from_session_seq`），既往场次的判定与负荷轨迹不回写；`planForSession(pid, seq)` 永远返回该场次当时生效的版本。分组计划不得超出医生参与范围。

### 去重与冲突

- **网络重传**：来源方 `record_id` 全局去重，重复提交只累计一次；
- **跨点参加**：同一日历日在多个场地签到，仅首个场次累计，其余标记 `cross_site_duplicate`；
- **缺席**：缺席与出席/负荷互相矛盾时不静默覆盖，负荷暂不计入，经 `confirmLoad` 人工确认后生效；
- **多源负荷**：穿戴设备、人工签到、本人补录差异超阈值即标记冲突，确认前不参与加量判断；医生视图中保留全部来源与确认状态，构成可信负荷历史。

### 紧急处置

胸痛、眩晕或急性损伤出现时，`risk.declareEmergency(...)` 一次性完成：记录异常信号 → 立即暂停 → **人工处置抢占普通课程**（场次登记事故、该参与者课程中断）→ 记录交接（处置人、接收方）→ 安排复评。复评完成（`completeReview`）后解除暂停并了结异常信号。

### 分角色访问

| 角色 | 视图 | 内容 |
| --- | --- | --- |
| 教练 | `coachRoster(sessionId)` | 仅带课必要信息：分组、当日状态、强度上限、是否已交接 |
| 参与者 | `participantStatus(pid)` | 自己的状态、中文依据、计划摘要、下次复评时间 |
| 医生 | `physicianHistory(pid)` | 完整档案与可信负荷历史（来源、冲突、确认状态） |
| 运营方 | `operatorSafetyReport({from,to})` | 仅去标识聚合计数；不足 5 人的分组拆分隐藏 |

### 事件不可改写

事件一旦被接收，其标识、发生时间和版本不允许原地改写；业务更正（如签到纠错 `correctAttendance`）产生带 `supersedes` 的后继事件。每个聚合内版本号连续递增，存储层拒绝跳号与重放。

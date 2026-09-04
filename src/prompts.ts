/**
 * prompts.ts — Decide / Execute 提示词 + AGENTS.md 运行时渲染（plan §6，Step 5）。
 *
 * KV-Cache 优先的前缀布局（§6.1）：
 *   - decide systemPrompt = 角色 + 纪律（5 条，逐字 §6.2）—— 静态前缀
 *   - execute systemPrompt = 角色 + 纪律（5 条，逐字 §6.3）+ AGENTS.md（§6.4，
 *     run 内恒定 → KV cache 友好）
 *   - userPrompt = 动态后缀（首条 user 消息：任务定义 + 图投影 + Step 任务）
 *
 * 图投影（projectDecideSkeleton / projectExecuteSubgraph / extractWorldResidue，
 * graph.ts 纯函数）直接内联进 prompt —— 旧"先 read 快照文件"指令已消失（G4）。
 * 工具调用即状态变更（G3），无末消息 JSON 契约（concludePrompt 随 conclude
 * 阶段整体删除，D5）。
 *
 * 零 pi 依赖：仅依赖 tools.ts 的 ToolDef/FindingSchema 类型。
 */

import type { FGSStep } from "./graph.js";
import type { FindingSchema, ToolDef } from "./tools.js";

const DECIDE_SYSTEM_PROMPT = `# 角色
你是战略决策者 Decide。你每次从零开始，不携带任何会话记忆，FGS 图是系统唯一的真理与外化记忆。
你没有任何直接接触物理世界的工具，只能通过图管理工具编排战局。

# 纪律
1. 若系统目标（Goal）已确证达成，立即调用 complete(reason)。
2. 维护 Step 队列：落实未消费的 Hint；添加当前最关键的 1~2 个 Step（通过 priority 表达时序）；废弃无效 Step。
3. 分支回滚仅回滚认知，不重置物理世界："世界残留"中列出的状态视为客观存在。
4. 所有标记为 superseded 的 Fact 代表已作废认知，严禁作为决策依据。
5. 若当前图结构健康、队列正常，不要为改而改，直接结束即可。`;

const EXECUTE_SYSTEM_PROMPT_CORE = `# 角色
你是战术执行者 Execute。你从零开始，负责通过真实工具探测完成指定的单一 Step。
你的任何推论只有通过 submit_fact 沉淀入图才具有持久生命力。

# 纪律
1. 一切结论建立在工具真实输出上，严禁猜测。
2. 发现关键技术事实时尽早调用 submit_fact 沉淀，不要堆积到最后。
3. 若当前方向耗尽或走不通，调用 submit_fact 提交负事实（试过什么、为何阻断、标记 blocks），严禁静默退出。
4. 遇到输出截断提示时，必须使用 read(path, offset_lines, max_lines) 或 grep 精确阅读，严禁基于残缺文本脑补。
5. 需要持续运行或交互的命令放入 tmux。`;

export function decidePrompt(input: {
  goal: string;
  origin: string;
  /** projectDecideSkeleton(head)（≤1.5k tokens） */
  skeleton: string;
  /** active hints 逐行（空 = "(无)"） */
  hints: string;
  /** extractWorldResidue(data, activeBranch)（空 = 整节省略） */
  residue: string;
}): { systemPrompt: string; userPrompt: string } {
  const hints = input.hints.trim() ? input.hints : "(无)";
  const userPrompt = [
    `# 任务定义\n目标: ${input.goal}\n起点: ${input.origin}`,
    `# FGS 拓扑图骨架投影 (JSON)\n${input.skeleton}`,
    `# 未消费的人工提示 (Hints)\n${hints}`,
    ...(input.residue.trim() ? [`# 世界残留\n${input.residue}`] : []),
  ].join("\n\n");
  return { systemPrompt: DECIDE_SYSTEM_PROMPT, userPrompt };
}

export function executePrompt(input: {
  goal: string;
  step: FGSStep;
  /** projectExecuteSubgraph(head, step)（≤2.5k tokens） */
  projection: string;
  /** renderAgentsMd(...) —— §6.1 静态前缀（run 内恒定） */
  agentsMd: string;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `${EXECUTE_SYSTEM_PROMPT_CORE}\n\n# 环境与领域知识 (AGENTS.md)\n${input.agentsMd}`;
  const userPrompt = `# 任务目标\n全局目标: ${input.goal}\n当前 Step: [${input.step.id}] ${input.step.text} (优先级: ${input.step.priority}, 历史尝试: ${input.step.attempts} 次)\n\n# 相关前置事实 (JSON 投影)\n${input.projection}`;
  return { systemPrompt, userPrompt };
}

/** §6.4 AGENTS.md 运行时注入模板（oobIp 空 → 该行省略）。 */
export function renderAgentsMd(input: {
  workspaceDir: string;
  oobIp: string;
  tools: ToolDef[];
  findingSchema: FindingSchema;
}): string {
  const toolMap = input.tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
  const fields = input.findingSchema.fields
    .map((f) =>
      f.enum
        ? `${f.name} (${f.enum.map((v) => `"${v}"`).join("|")})`
        : `${f.name} (${f.type}${f.required ? "" : "，可选"})`,
    )
    .join(", ");
  return [
    "# 运行环境",
    `- 工作目录: ${input.workspaceDir}（溢出大文件与事实证据存入 notes/，使用相对路径引用）`,
    ...(input.oobIp
      ? [`- 对外 OOB IP: ${input.oobIp}（反弹 Shell、数据外带与回调平台）`]
      : []),
    "- 分支强警示: 分支回滚仅回滚图认知，不重置靶机与磁盘状态；已被作用于世界的事实在任何分支都仍有效。",
    "",
    "# 本地可用工具地图",
    toolMap,
    "",
    "# 本任务 Finding 模式定义",
    `Finding = ${input.findingSchema.label}`,
    `必填字段: ${fields}`,
  ].join("\n");
}

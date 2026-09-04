/** prompts.ts 测试（Step 5）— 新模板断言：骨架/残留/AGENTS.md 注入、空 hints 占位、
 * residue 空省略整节、oobIp 空行省略、systemPrompt 静态前缀（不含动态投影）。
 * Run: node test/run.mjs prompts
 */
import assert from "node:assert";
import { decidePrompt, executePrompt, renderAgentsMd } from "../src/prompts.ts";
import { DECIDE_TOOLS, DEFAULT_FINDING_SCHEMA, makeExecuteTools } from "../src/tools.ts";
import type { FGSStep } from "../src/graph.ts";

const step: FGSStep = { id: "s-3", text: "检查 zip 密码", priority: 20, status: "pending", attempts: 1 };
const skeleton = JSON.stringify({ goal: "g", origin: "o", steps: [] });
const projection = JSON.stringify({ goal: "g", facts: [] });
const agentsMd = renderAgentsMd({
  workspaceDir: "/ws",
  oobIp: "203.0.113.7",
  tools: makeExecuteTools(),
  findingSchema: DEFAULT_FINDING_SCHEMA,
});

// ── decide：注入位置 + 静态前缀 ─────────────────────────────────────────────
{
  const d = decidePrompt({ goal: "goal-A", origin: "origin-A", skeleton, hints: "hint-1\nhint-2", residue: "# 世界残留\n- f-2: x" });
  assert.ok(d.systemPrompt.includes("你是战略决策者 Decide"), "decide 角色");
  assert.ok(d.systemPrompt.includes("5. 若当前图结构健康、队列正常，不要为改而改"), "decide 纪律 5 条");
  assert.ok(!d.systemPrompt.includes(skeleton), "systemPrompt 静态前缀不含动态骨架");
  assert.ok(d.userPrompt.includes("目标: goal-A") && d.userPrompt.includes("起点: origin-A"), "任务定义");
  assert.ok(d.userPrompt.includes(skeleton), "骨架投影内联");
  assert.ok(d.userPrompt.includes("hint-1\nhint-2"), "hints 逐行注入");
  assert.ok(d.userPrompt.includes("# 世界残留"), "residue 存在时注入");
}
// 空 hints → "(无)" 占位；residue 空 → 整节省略
{
  const d = decidePrompt({ goal: "g", origin: "o", skeleton, hints: "  ", residue: "" });
  assert.ok(d.userPrompt.includes("(无)"), "空 hints 占位");
  assert.ok(!d.userPrompt.includes("# 世界残留"), "residue 空省略整节");
}

// ── execute：角色+纪律+AGENTS.md 进 systemPrompt，投影进 userPrompt ─────────
{
  const e = executePrompt({ goal: "goal-B", step, projection, agentsMd });
  assert.ok(e.systemPrompt.includes("你是战术执行者 Execute"), "execute 角色");
  assert.ok(e.systemPrompt.includes("3. 若当前方向耗尽或走不通，调用 submit_fact 提交负事实"), "execute 纪律 3");
  assert.ok(e.systemPrompt.includes(agentsMd), "AGENTS.md 进 systemPrompt（静态前缀）");
  assert.ok(!e.systemPrompt.includes(projection), "systemPrompt 不含动态投影");
  assert.ok(e.userPrompt.includes("全局目标: goal-B"));
  assert.ok(e.userPrompt.includes("[s-3] 检查 zip 密码 (优先级: 20, 历史尝试: 1 次)"), "step 元数据");
  assert.ok(e.userPrompt.includes(projection), "投影内联 userPrompt");
}

// ── AGENTS.md：workspaceDir/工具地图/finding schema；oobIp 空行省略 ────────
{
  assert.ok(agentsMd.includes("- 工作目录: /ws"), "workspaceDir");
  assert.ok(agentsMd.includes("203.0.113.7"), "oobIp 行存在");
  assert.ok(agentsMd.includes("- bash: ") && agentsMd.includes("- submit_fact: "), "工具地图");
  assert.ok(agentsMd.includes("Finding = 安全漏洞 / 突破口 / 标志 Flag"), "finding label");
  assert.ok(agentsMd.includes('severity ("info"|"low"|"medium"|"high"|"critical")'), "severity enum 逐字");
  const noOob = renderAgentsMd({ workspaceDir: "/ws", oobIp: "", tools: DECIDE_TOOLS, findingSchema: DEFAULT_FINDING_SCHEMA });
  assert.ok(!noOob.includes("OOB IP"), "oobIp 空 → 行省略");
  assert.ok(noOob.includes("- add_step: "), "decide 工具地图");
}

console.log("prompts.test: all assertions passed");

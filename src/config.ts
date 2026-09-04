/**
 * config.ts — ~/.pi/agent/cairn.json 运行时配置 + Provider/Model 单例 (PLAN §2.1/§9.1 Step 1).
 *
 * 0 外部 Agent 框架依赖：provider 直接由 @earendil-works/pi-ai 的
 * OpenAI-compatible (llama.cpp) 流构建。文件可选，全部字段有默认值，
 * CAIRN_* 环境变量覆盖（测试与部署调参用）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createProvider,
  type Api,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  stream as ocStream,
  streamSimple as ocStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";

export interface CairnConfig {
  /** OpenAI-compatible endpoint, e.g. http://127.0.0.1:8080/v1 */
  baseUrl: string;
  /** 本地服务器可任意填 */
  apiKey: string;
  /** Execute/Conclude 模型 id */
  model: string;
  /** 空 = 与 model 相同 */
  decideModel: string;
  /** loop.ts 软水位（90%）与硬溢出判定的窗口基准 */
  contextWindow: number;
  /** 注入 AGENTS.md 的 OOB 出口 IP */
  oobIp: string;
  /** 单次活动（Decide/Execute）最大 turn 数 */
  maxTurns: number;
  /** 单次活动整体墙钟超时 */
  activityTimeoutMs: number;
  /** 单次 HTTP turn 超时 */
  turnTimeoutMs: number;
  /** bash 工具默认超时秒 */
  bashTimeoutSec: number;
  /** 全局 Execute 预算 */
  maxExecutes: number;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "cairn.json");

export const DEFAULTS: CairnConfig = {
  baseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "cairn",
  model: "",
  decideModel: "",
  contextWindow: 32768,
  oobIp: "",
  maxTurns: 30,
  activityTimeoutMs: 15 * 60 * 1000,
  turnTimeoutMs: 5 * 60 * 1000,
  bashTimeoutSec: 30,
  maxExecutes: 60,
};

let cached: CairnConfig | null = null;

export function loadConfig(): CairnConfig {
  if (cached) return cached;
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* 无配置文件 = 纯默认 + env */
  }
  const s = (k: string, env?: string) =>
    (file[k] as string | undefined) ?? (env ? process.env[env] : undefined);
  const num = (k: string, env?: string) => {
    const raw =
      (typeof file[k] === "number" ? String(file[k]) : undefined) ??
      (env ? process.env[env] : undefined);
    return raw !== undefined && raw !== "" && !Number.isNaN(Number(raw))
      ? Number(raw)
      : undefined;
  };
  cached = {
    baseUrl: s("baseUrl", "CAIRN_BASE_URL") ?? DEFAULTS.baseUrl,
    apiKey: s("apiKey", "CAIRN_API_KEY") ?? DEFAULTS.apiKey,
    model: s("model", "CAIRN_MODEL") ?? DEFAULTS.model,
    decideModel: s("decideModel", "CAIRN_DECIDE_MODEL") ?? DEFAULTS.decideModel,
    contextWindow: num("contextWindow", "CAIRN_CONTEXT_WINDOW") ?? DEFAULTS.contextWindow,
    oobIp: s("oobIp", "CAIRN_OOB_IP") ?? DEFAULTS.oobIp,
    maxTurns: num("maxTurns", "CAIRN_MAX_TURNS") ?? DEFAULTS.maxTurns,
    activityTimeoutMs: num("activityTimeoutMs", "CAIRN_ACTIVITY_TIMEOUT_MS") ?? DEFAULTS.activityTimeoutMs,
    turnTimeoutMs: num("turnTimeoutMs", "CAIRN_TURN_TIMEOUT_MS") ?? DEFAULTS.turnTimeoutMs,
    bashTimeoutSec: num("bashTimeoutSec", "CAIRN_BASH_TIMEOUT_SEC") ?? DEFAULTS.bashTimeoutSec,
    maxExecutes: num("maxExecutes", "CAIRN_MAX_EXECUTES") ?? DEFAULTS.maxExecutes,
  };
  if (!cached.model)
    throw new Error(
      `cairn: 未配置 model —— 写入 ${CONFIG_PATH} 或设置 CAIRN_MODEL`,
    );
  return cached;
}

/** 测试用：清除单例（config 文件与 env 重读）。 */
export function resetConfig(): void {
  cached = null;
  providerInstance = null;
}

// ---------------------------------------------------------------- provider

function makeModel(id: string, cfg: CairnConfig): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "cairn",
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: 4096,
  };
}

let providerInstance: Provider | null = null;

/** Provider 实例单例（PLAN §9.1 Step 1）。 */
export function getProvider(): Provider {
  if (providerInstance) return providerInstance;
  const cfg = loadConfig();
  const ids = [cfg.model, cfg.decideModel].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  providerInstance = createProvider({
    id: "cairn",
    name: "cairn",
    baseUrl: cfg.baseUrl,
    auth: {
      apiKey: {
        name: "cairn.json",
        resolve: async () => ({ auth: { apiKey: cfg.apiKey } }),
      },
    },
    models: ids.map((id) => makeModel(id, cfg)),
    api: { stream: ocStream, streamSimple: ocStreamSimple },
  });
  return providerInstance;
}

/** 解析模型引用（"" = execute 模型）。 */
export function getModel(ref?: string): Model<Api> {
  const cfg = loadConfig();
  const id = ref || cfg.model;
  const m = getProvider().getModels().find((x) => x.id === id);
  if (!m) throw new Error(`cairn: 模型 "${id}" 未配置（见 ${CONFIG_PATH}）`);
  return m;
}

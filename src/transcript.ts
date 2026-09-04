import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// transcript.ts — 活动日志（carin_plan §2.1/§2.2/§6.1，Step 4）
//
// 职责边界：
//   - 每次活动（Decide/Execute）一个 JSONL：transcripts/act-<n>-<kind>[-<stepId>].jsonl
//   - 内存 Ring Buffer 5000 条（跨活动共享，SSE 重连回放友好）
//   - 广播钩子（SSE 连接池 Step 7 接入，本步只留 listener 挂载点）
//   - 不做：HTTP/SSE（Step 7）、活动编号业务语义（engine，Step 5）
//
// 写盘协议：openSync(O_WRONLY|O_CREAT|O_APPEND) fd 常驻 + writeSync(JSON+\n)
//   —— 同步单写者，无跨进程竞争；append 顺序固定：① 写盘 ② 入 ring ③ 通知 listener，
//   SSE 客户端与文件永远一致。
//
// 活动编号：open 时从 transcripts/ 目录 list 推 maxNumId 自增（与 maxNumId 同模式）
//   —— 不改 run.json，崩溃重启自动续号。
//
// 依赖面：node:fs + node:path
// ---------------------------------------------------------------------------

const RING_SIZE = 5000;

export type ActivityKind = "decide" | "execute";

export interface TranscriptEvent {
  ts: number;
  /** "act-003" */
  activityId: string;
  kind: ActivityKind;
  stepId?: string;
  /** LoopEvent payload 透传（type/turn/...） */
  [key: string]: unknown;
}

/** 追加 payload（ts/activityId/kind/stepId 由 Transcript 补齐） */
export type TranscriptPayload = Omit<TranscriptEvent, "ts" | "activityId" | "kind" | "stepId"> & { stepId?: never };

// ── 模块级单例状态 ────────────────────────────────────────────────────────────

const ring: TranscriptEvent[] = [];
const listeners = new Set<(ev: TranscriptEvent) => void>();
const cache = new Map<string, Transcript>(); // key: `${runDir}::${activityId}`

/** 跨活动最近 n 条（供 GET /api/transcript，Step 7 接入） */
export function ringTail(n: number): TranscriptEvent[] {
  return ring.slice(-n);
}

/** Step 7 挂 SSE 池；返回解绑函数（内部便利，不改变 void 语义使用方式） */
export function onTranscriptEvent(fn: (ev: TranscriptEvent) => void): void {
  listeners.add(fn);
}

function nextActivityNum(runDir: string): number {
  const dir = join(runDir, "transcripts");
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const f of readdirSync(dir)) {
    const m = /^act-(\d{3,})-(decide|execute)/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export class Transcript {
  readonly runDir: string;
  readonly activityId: string;
  readonly kind: ActivityKind;
  readonly stepId?: string;
  readonly path: string;
  private fd: number;

  private constructor(runDir: string, activityId: string, kind: ActivityKind, stepId: string | undefined) {
    this.runDir = runDir;
    this.activityId = activityId;
    this.kind = kind;
    this.stepId = stepId;
    const file = `act-${String(parseInt(activityId.slice(4), 10)).padStart(3, "0")}-${kind}${stepId ? `-${stepId}` : ""}.jsonl`;
    this.path = join(runDir, "transcripts", file);
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, "a", 0o644); // O_WRONLY|O_CREAT|O_APPEND（"a"），fd 常驻
  }

  /**
   * 幂等打开：同 (runDir, activityId) 重复 open 返回同一实例（Map 缓存），不重复建文件。
   * activityId 省略时从 transcripts/ 目录推 maxNumId 自增（崩溃重启自动续号）。
   */
  static open(runDir: string, kind: ActivityKind, stepId?: string, activityId?: string): Transcript {
    const id = activityId ?? `act-${String(nextActivityNum(runDir)).padStart(3, "0")}`;
    const key = `${runDir}::${id}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const t = new Transcript(runDir, id, kind, stepId);
    cache.set(key, t);
    return t;
}

  /** ① 写盘 ② 入 ring ③ 通知 listener —— 顺序固定 */
  append(payload: Record<string, unknown>): void {
    const ev: TranscriptEvent = { ...payload, ts: Date.now(), activityId: this.activityId, kind: this.kind };
    if (this.stepId !== undefined) ev.stepId = this.stepId;
    writeSync(this.fd, JSON.stringify(ev) + "\n");
    ring.push(ev);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch {
        // listener 异常不影响写盘与 ring（SSE 池 Step 7 自带容错）
      }
    }
  }

  /** 从 ring 取本活动最近 n 条 */
  tail(n: number): TranscriptEvent[] {
    return ring.filter((e) => e.activityId === this.activityId).slice(-n);
  }

  /** 移出缓存（fd 常驻，活动短命，无需 flush；进程退出 OS 回收） */
  close(): void {
    cache.delete(`${this.runDir}::${this.activityId}`);
    closeSync(this.fd);
  }
}

/** 测试辅助：重置模块级单例状态（ring/listeners/cache）。生产代码不应调用。 */
export function __resetTranscriptStateForTest(): void {
  ring.length = 0;
  listeners.clear();
  cache.clear();
}

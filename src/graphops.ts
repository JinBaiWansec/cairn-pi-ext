/**
 * GraphOps — fgs.json 的 Single-Writer（plan §4.1 / §7 单写者铁律）。
 *
 * 一切图变更走 applyOp()：深克隆 head 图 → 执行 mutator → 追加一条不可变
 * FGSRevision（rev-<n> 全局递增）→ 原子落盘（tmp + rename）。分支 fork 通过
 * 切片共享既有 revision 数组实现——revision 本身永不被修改（认知分叉 ≠ 环境
 * 分叉：分支只回滚图认知，不重置靶机物理状态）。
 */

import {
  type FGSBranch,
  type FGSGraph,
  type FGSFile,
  type FGSRevision,
} from "./graph.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type OpBy = "model" | "user";
export type OpMutator = (g: FGSGraph) => void;

const fileOf = (runDir: string) => join(runDir, "fgs.json");

export class GraphOps {
  readonly file: string;
  data: FGSFile;

  private constructor(file: string, data: FGSFile) {
    this.file = file;
    this.data = data;
  }

  /** 新建 Run：main 分支以 origin/goal 空图起始（rev-1, op=init, by=user）。 */
  static create(runDir: string, origin: string, goal: string): GraphOps {
    const file = fileOf(runDir);
    if (existsSync(file)) throw new Error(`fgs.json already exists at ${file}`);
    const init: FGSGraph = {
      origin,
      goal,
      subgoals: [],
      steps: [],
      facts: [],
      findings: [],
      hints: [],
    };
    const rev: FGSRevision = {
      id: "rev-1",
      parent: null,
      op: "init",
      by: "user",
      ts: Date.now(),
      graph: init,
    };
    const data: FGSFile = {
      version: 2,
      revCounter: 1,
      branches: [{ name: "main", head: rev.id, revisions: [rev] }],
      activeBranch: "main",
    };
    const ops = new GraphOps(file, data);
    ops.save();
    return ops;
  }

  /** 崩溃恢复加载。 */
  static load(runDir: string): GraphOps {
    const file = fileOf(runDir);
    if (!existsSync(file)) throw new Error(`no fgs.json at ${file}`);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(
        `failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let data: FGSFile;
    try {
      data = JSON.parse(raw) as FGSFile;
    } catch (e) {
      throw new Error(
        `corrupt fgs.json at ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (data.version !== 2)
      throw new Error(`unsupported fgs version ${data.version}`);
    return new GraphOps(file, data);
  }

  static exists(runDir: string): boolean {
    return existsSync(fileOf(runDir));
  }

  branch(name: string): FGSBranch {
    const b = this.data.branches.find((x) => x.name === name);
    if (!b) throw new Error(`unknown branch ${name}`);
    return b;
  }

  get activeBranch(): FGSBranch {
    return this.branch(this.data.activeBranch);
  }

  /** 分支的 head 图（不可变快照）。 */
  headGraph(branch?: FGSBranch): FGSGraph {
    const b = branch ?? this.activeBranch;
    const head = b.revisions.find((r) => r.id === b.head);
    if (!head) throw new Error(`branch ${b.name} has no head revision ${b.head}`);
    return head.graph;
  }

  /**
   * 唯一写入口：clone head → mutate → 追加 revision → 原子落盘。
   * 返回新 revision；既有 revision 永不被修改。
   */
  applyOp(op: string, by: OpBy, mutate: OpMutator, note?: string): FGSRevision {
    const b = this.activeBranch;
    const draft = structuredClone(this.headGraph(b));
    mutate(draft);
    this.data.revCounter += 1;
    const rev: FGSRevision = {
      id: `rev-${this.data.revCounter}`,
      parent: b.head,
      op,
      by,
      ts: Date.now(),
      ...(note ? { note } : {}),
      graph: draft,
    };
    b.revisions.push(rev);
    b.head = rev.id;
    this.save();
    return rev;
  }

  /**
   * 从 (fromBranch 的) fromRevision fork 新分支（默认：活跃分支 head）。
   * 新分支共享 fork 点及之前的 revision 切片；不切换活跃分支。
   */
  forkBranch(
    name: string,
    fromBranch?: string,
    fromRevision?: string,
  ): FGSBranch {
    if (this.data.branches.some((b) => b.name === name))
      throw new Error(`branch ${name} already exists`);
    const src = this.branch(fromBranch ?? this.data.activeBranch);
    const at = fromRevision ?? src.head;
    const idx = src.revisions.findIndex((r) => r.id === at);
    if (idx < 0) throw new Error(`revision ${at} not on branch ${src.name}`);
    const nb: FGSBranch = {
      name,
      forkFromRevision: at,
      forkFromBranch: src.name,
      head: at,
      revisions: src.revisions.slice(0, idx + 1),
    };
    this.data.branches.push(nb);
    this.save();
    return nb;
  }

  /** 切换活跃分支（元数据写，不产生 revision）。 */
  switchBranch(name: string): void {
    this.branch(name);
    this.data.activeBranch = name;
    this.save();
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}

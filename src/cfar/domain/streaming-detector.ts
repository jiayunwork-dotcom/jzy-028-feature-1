import { alphaFactor } from './alpha';
import { validateAmplitudes } from './detector';
import { CfarError } from './errors';
import { validateGeometry, WindowGeometry } from './geometry';

/**
 * 持续检测（流式 CA-CFAR）领域模型。
 *
 * 与一趟式 runCaCfar 的语义完全相同，只是数据可以分批追加：
 *
 *   布局： ... 左侧参考 | 左侧保护 | CUT | 右侧保护 | 右侧参考 ...
 *   h = guardCells + referenceCellsPerSide（CUT 单侧伸出去的最远长度）
 *
 * 全局下标 i 的单元在已收到 n 个幅度时：
 *   - 左侧到齐  <=> i >= h            （i < h 的单元左窗永远不会到齐）
 *   - 右侧到齐  <=> i + h < n
 *
 * 每追加一批，只产出"因这批数据而状态发生变化"的单元事件：
 *   1. 上一批末尾暂定无效、这批右侧参考补齐的单元 -> 追溯性正式判决（retroactive）；
 *   2. 本批新到的单元：左窗永不到齐 -> 终态无效；右窗未到齐 -> 暂定无效；
 *      两侧已齐 -> 直接正式判决。
 * 已经落定（final=true）的单元不会出现在后续任何一批的事件里。
 */

/** 单元事件状态：settled=正式判决；invalid=无效（阈值 null、不检出）。 */
export type CellState = 'settled' | 'invalid';

export interface CellEvent {
  /** 全局距离单元下标（从 0 开始，按追加顺序编号） */
  index: number;
  state: CellState;
  /** settled 时为阈值；invalid 时恒为 null（绝不拿未到达的参考补零） */
  threshold: number | null;
  detection: boolean;
  /** false=暂定结果（右侧参考未到齐，以后可能追溯重判）；true=正式落定，此后不再改写 */
  final: boolean;
  /** true=本事件是在追溯改写该单元早先给出的暂定无效 */
  retroactive: boolean;
}

interface CellRecord {
  state: CellState;
  threshold: number | null;
  detection: boolean;
  final: boolean;
  retroactive: boolean;
}

export interface SessionView {
  state: 'open' | 'closed';
  geometry: WindowGeometry;
  alpha: number;
  /** 两侧参考总数 N=2*referenceCellsPerSide */
  n: number;
  /** 累计已追加单元数 */
  totalCells: number;
  /** 当前实际保留的末尾历史幅度个数 */
  retainedCells: number;
  /** 保留上限 = 2*(guardCells+referenceCellsPerSide)，与批次数/总线长无关 */
  retainedLimit: number;
  /** 两侧参考尚未到齐、仍可能被追溯重判的单元数 */
  pendingCells: number;
  /** 已经给出正式结果（含终态无效）的单元数累计 */
  finalizedCells: number;
}

export class StreamingCfarSession {
  private readonly g: number;
  private readonly r: number;
  private readonly h: number;
  private readonly alpha: number;
  private readonly nRef: number;

  /** 末尾历史幅度；raw[0] 对应全局下标 rawBase。 */
  private raw: number[] = [];
  private rawBase = 0;
  /** 仍在保留窗口内的单元判决记录（与 raw 同一边界裁剪）。 */
  private readonly results = new Map<number, CellRecord>();
  /** 下标小于该值的判决记录已随末尾历史一起丢弃（正式结果已在事件流中交付）。 */
  private forgottenBefore = 0;

  private total = 0;
  private finalizedCount = 0;
  private closed = false;
  private readonly createdAt: number;
  private lastActivityAt: number;

  constructor(
    rawGeometry: unknown,
    private readonly clock: () => number = () => Date.now(),
  ) {
    const geometry: WindowGeometry = validateGeometry(
      rawGeometry as Partial<WindowGeometry>,
    );
    this.g = geometry.guardCells;
    this.r = geometry.referenceCellsPerSide;
    this.h = this.g + this.r;
    this.nRef = 2 * this.r;
    this.alpha = alphaFactor(geometry.pfa, this.nRef);
    this.geometry = geometry;
    this.createdAt = clock();
    this.lastActivityAt = this.createdAt;
  }

  readonly geometry: WindowGeometry;

  get isClosed(): boolean {
    return this.closed;
  }

  get createdTime(): number {
    return this.createdAt;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /**
   * 追加一批幅度，返回本批引起状态变化的单元事件（按全局下标升序）。
   * 不重新扫描、不重新判决任何已落定单元。
   */
  append(rawAmplitudes: unknown): CellEvent[] {
    if (this.closed) {
      throw new CfarError('cannot append amplitudes to a closed detection session');
    }
    const batch = validateAmplitudes(rawAmplitudes);

    const oldTotal = this.total;
    for (const value of batch) {
      this.raw.push(value);
    }
    this.total = oldTotal + batch.length;

    const events: CellEvent[] = [];

    // 1) 上一批末尾暂定无效的单元中，右侧参考恰好被这批补齐的 -> 追溯性正式判决。
    //    上一批结束时暂定区间为 [max(h, oldTotal-h), oldTotal)。
    const pendingStart = Math.max(this.h, oldTotal - this.h);
    for (let i = pendingStart; i < oldTotal; i++) {
      if (i + this.h < this.total) {
        events.push(this.settle(i, true));
      }
    }

    // 2) 本批新到单元。
    for (let i = oldTotal; i < this.total; i++) {
      if (i < this.h) {
        // 左侧参考永远凑不齐（没有负下标）-> 与一趟式左边缘一致，终态无效。
        events.push(this.markInvalid(i, true, false));
      } else if (i + this.h >= this.total) {
        // 右侧参考还没到齐 -> 暂定无效，不给阈值，等后续批次追溯。
        events.push(this.markInvalid(i, false, false));
      } else {
        // 批次足够大，两侧参考到达即齐 -> 直接正式判决。
        events.push(this.settle(i, false));
      }
    }

    // 3) 正式判决/保留只依赖末尾一段；更老的原始幅度和记录立即丢弃。
    this.prune();
    this.lastActivityAt = this.clock();
    return events;
  }

  /**
   * 显式关闭会话：仍在暂定（右侧参考永远不会再来）的单元按一趟式右边缘语义
   * 落定为终态无效（追溯改写早先的暂定无效），随后释放全部保留历史。
   */
  close(): CellEvent[] {
    if (this.closed) {
      throw new CfarError('detection session is already closed');
    }
    const events: CellEvent[] = [];
    const pendingStart = Math.max(this.h, this.total - this.h);
    for (let i = pendingStart; i < this.total; i++) {
      events.push(this.markInvalid(i, true, true));
    }
    this.closed = true;
    this.raw = [];
    this.rawBase = this.total;
    this.results.clear();
    this.forgottenBefore = this.total;
    return events;
  }

  /**
   * 查询仍在保留窗口内的单元最新判决。
   * @returns 记录；下标已超出保留窗口返回 'forgotten'；下标还没追加到返回 'future'。
   */
  resultAt(index: number): CellRecord | 'forgotten' | 'future' {
    if (!Number.isInteger(index) || index < 0) {
      throw new CfarError('cell index must be a non-negative integer');
    }
    if (index < this.forgottenBefore) {
      return 'forgotten';
    }
    if (index >= this.total) {
      return 'future';
    }
    const record = this.results.get(index);
    // 不变量：[forgottenBefore, total) 内的每个单元都有记录。
    /* istanbul ignore next */
    if (record === undefined) {
      throw new CfarError(`internal error: missing record for cell ${index}`);
    }
    return record;
  }

  view(): SessionView {
    return {
      state: this.closed ? 'closed' : 'open',
      geometry: this.geometry,
      alpha: this.alpha,
      n: this.nRef,
      totalCells: this.total,
      retainedCells: this.raw.length,
      retainedLimit: 2 * this.h,
      pendingCells: this.closed ? 0 : Math.max(0, Math.min(this.h, this.total - this.h)),
      finalizedCells: this.finalizedCount,
    };
  }

  /**
   * 正式判决一个两侧参考均已到齐的单元。
   * 参考下标范围与一趟式 reference-window 完全一致：
   *   左参考 [i-h, i-g)，右参考 [i+g+1, i+h+1)
   * CUT 与保护单元都不进均值。
   */
  private settle(index: number, retroactive: boolean): CellEvent {
    const at = (globalIndex: number): number =>
      this.raw[globalIndex - this.rawBase];

    let leftSum = 0;
    for (let k = index - this.h; k < index - this.g; k++) {
      leftSum += at(k);
    }
    let rightSum = 0;
    for (let k = index + this.g + 1; k < index + this.h + 1; k++) {
      rightSum += at(k);
    }

    const threshold = ((leftSum + rightSum) / this.nRef) * this.alpha;
    const detection = at(index) > threshold; // 严格压过阈值才算检出
    const record: CellRecord = {
      state: 'settled',
      threshold,
      detection,
      final: true,
      retroactive,
    };
    this.results.set(index, record);
    this.finalizedCount += 1;
    return { index, ...record };
  }

  private markInvalid(index: number, final: boolean, retroactive: boolean): CellEvent {
    const record: CellRecord = {
      state: 'invalid',
      threshold: null,
      detection: false,
      final,
      retroactive,
    };
    this.results.set(index, record);
    if (final) {
      this.finalizedCount += 1;
    }
    return { index, ...record };
  }

  /**
   * 裁剪历史：本批之后，下一批最先可能被判决的 CUT 是 total-h，
   * 它最左的参考下标是 total-2h；任何全局下标 < total-2h 的幅度都不会
   * 再被任何参考窗读到，连同其判决记录一起丢弃。
   * 保留量恒为 min(total, 2h)，只随 g、r 变化，不随批次数增长。
   */
  private prune(): void {
    const keepFrom = this.total - 2 * this.h;
    if (keepFrom <= this.rawBase) {
      return;
    }
    this.raw = this.raw.slice(keepFrom - this.rawBase);
    this.rawBase = keepFrom;
    for (const key of this.results.keys()) {
      if (key < keepFrom) {
        this.results.delete(key);
      }
    }
    this.forgottenBefore = keepFrom;
  }
}

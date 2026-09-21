import { alphaFactor } from './alpha';
import { validateAmplitudes } from './detector';
import { validateGeometry, WindowGeometry } from './geometry';
import { totalReferenceCount } from './reference-window';

/**
 * 一个单元在会话中的当前判决。
 *
 * final=false：右侧参考窗尚未到齐，先标无效、不给阈值；后续批次把窗口补齐后
 *              会被追溯性重判（revision 随之 +1）。
 * final=true ：窗口两侧都已到齐，判决落定。此后任何追加都不会再改写它。
 */
export interface StreamCellJudgment {
  /** 全局单元下标（跨批次单调递增，从 0 起） */
  index: number;
  threshold: number | null;
  detection: boolean;
  invalid: boolean;
  final: boolean;
  /** 该单元被判定的次数：到点标无效为 1，窗口补齐后追溯重判为 2；落定后不再变 */
  revision: number;
}

export interface AppendOutcome {
  /** 本批第一个单元的全局下标 */
  baseIndex: number;
  /** 本批新到、但右侧参考窗尚未凑齐的单元（当前无效，非最终判决） */
  pending: StreamCellJudgment[];
  /**
   * 因为本批到达而得以落定的单元（含对之前 pending 单元的追溯重判）。
   * 只含这些单元——更早落定的单元绝不重算、也不重复返回。
   */
  finalized: StreamCellJudgment[];
  /** 累计接收幅度数 */
  received: number;
  /** 已落定单元总数 */
  finalizedCount: number;
  /** 当前待定（已到但未落定）单元数 */
  pendingCount: number;
  /**
   * 当前保留的原始幅度个数。上界 2×(guardCells+referenceCellsPerSide)，
   * 只随窗几何变化，不随追加批次数增长。
   */
  retainedAmplitudes: number;
}

export interface SessionStatus {
  geometry: WindowGeometry;
  alpha: number;
  n: number;
  received: number;
  finalizedCount: number;
  pendingCount: number;
  retainedAmplitudes: number;
}

/**
 * 持续检测会话：同一根波束上分批追加幅度，增量式 CA-CFAR 判决。
 *
 * 不变式：任意时刻，会话对全部已接收单元的当前判决，与把已接收前缀整条
 * 送入 runCaCfar 的结果完全一致（含阈值逐位一致——前缀和按与单趟相同的
 * 递推次序累计，且取窗、求均值、乘 α 的运算次序与 runCaCfar 相同）。
 *
 * 内存：原始幅度与前缀和只保留末尾一段（≤ 2×(guard+ref)+1 个前缀值），
 * 落定前沿之前、任何未来判决都不再需要的数据即追加即弃。
 */
export class StreamingCfarSession {
  readonly geometry: WindowGeometry;
  readonly alpha: number;
  readonly n: number;

  /** 累计接收幅度数（= 下一个单元的全局下标 + 1） */
  private receivedCount = 0;
  /** 落定前沿：下一个小待落定单元的全局下标（之前的单元全部已落定） */
  private finalizedCount = 0;
  /** ampBuf[0] / prefixBuf[0] 对应的全局下标 / 前缀位置 */
  private bufBase = 0;
  /** 末尾一段原始幅度，长度 ≤ 2×(guard+ref) */
  private ampBuf: number[] = [];
  /**
   * 与 ampBuf 对齐的前缀和：prefixBuf[j] 是全局位置 bufBase+j 处的前缀和
   * （即前 bufBase+j 个幅度之和），长度 = ampBuf.length + 1。
   * 递推次序与 runCaCfar 完全一致，保证分批送入与整条送入结果逐位相同。
   */
  private prefixBuf: number[] = [0];
  private lastPrefix = 0;

  // 全量判决结果（供事后查询某个单元）；原始幅度只留末尾一段，
  // 判决结果本身（阈值/检出/无效/落定/次数）紧凑保留到会话关闭。
  private thresholds: (number | null)[] = [];
  private detections: boolean[] = [];
  private invalids: boolean[] = [];
  private finals: boolean[] = [];
  private revisions: number[] = [];

  constructor(rawGeometry: unknown) {
    this.geometry = validateGeometry(rawGeometry as Partial<WindowGeometry>);
    this.n = totalReferenceCount(this.geometry.referenceCellsPerSide);
    this.alpha = alphaFactor(this.geometry.pfa, this.n);
  }

  /**
   * 追加一批幅度。只对"因为本批到达而变得可以下判"的单元给出判决：
   *   1. 新到单元右窗未齐的先标无效（revision=1）；
   *   2. 落定前沿单调推进，窗口到齐的单元逐个落定——左缘永远凑不齐的
   *      落定无效（绝不补零），其余按参考均值×α 给阈值；
   *   3. 前沿之前不再需要的原始幅度与前缀和立即丢弃。
   */
  append(rawAmplitudes: unknown): AppendOutcome {
    const amps = validateAmplitudes(rawAmplitudes);
    const { guardCells, referenceCellsPerSide } = this.geometry;
    const span = guardCells + referenceCellsPerSide; // 单侧跨度：保护 + 参考
    const baseIndex = this.receivedCount;

    for (const a of amps) {
      this.ampBuf.push(a);
      this.lastPrefix += a;
      this.prefixBuf.push(this.lastPrefix);
      this.receivedCount++;
    }

    // 下标 ≤ frontier 的单元右侧参考窗已经到齐（右缘下标 cut+span ≤ received-1）
    const frontier = this.receivedCount - 1 - span;

    // 新到单元先登记占位：本批内即可落定的留 revision=0 待下面落定；
    // 右窗未齐的标无效（revision=1），等后续批次补齐后追溯重判。
    for (let i = baseIndex; i < this.receivedCount; i++) {
      this.thresholds.push(null);
      this.detections.push(false);
      this.invalids.push(true);
      this.finals.push(false);
      this.revisions.push(i <= frontier ? 0 : 1);
    }

    // 推进落定前沿：只判定 (旧前沿, 新前沿] 这一段，更早落定的单元绝不重算。
    const finalized: StreamCellJudgment[] = [];
    while (this.finalizedCount <= frontier) {
      const cut = this.finalizedCount;
      if (cut < span) {
        // 左缘：左侧参考永远凑不齐，落定无效、不检出、阈值为 null（不补零）
        this.thresholds[cut] = null;
        this.detections[cut] = false;
        this.invalids[cut] = true;
      } else {
        // 取窗与运算次序和 runCaCfar 完全相同，保证结果逐位一致
        const leftStart = cut - span; // = cut - guardCells - referenceCellsPerSide
        const leftEnd = cut - guardCells; // 不含
        const rightStart = cut + guardCells + 1;
        const rightEnd = cut + guardCells + 1 + referenceCellsPerSide; // 不含
        const referenceSum =
          this.prefixAt(leftEnd) -
          this.prefixAt(leftStart) +
          this.prefixAt(rightEnd) -
          this.prefixAt(rightStart);
        const threshold = (referenceSum / this.n) * this.alpha;
        this.thresholds[cut] = threshold;
        this.detections[cut] = this.ampBuf[cut - this.bufBase] > threshold;
        this.invalids[cut] = false;
      }
      this.finals[cut] = true;
      this.revisions[cut] += 1;
      finalized.push(this.snapshot(cut));
      this.finalizedCount++;
    }

    // 丢弃落定前沿之前、任何未来判决都不再需要的原始数据：
    // 下一个待落定单元 finalizedCount 的左参考起点是 finalizedCount - span。
    const keepFrom = this.finalizedCount - span;
    if (keepFrom > this.bufBase) {
      const drop = keepFrom - this.bufBase;
      this.ampBuf.splice(0, drop);
      this.prefixBuf.splice(0, drop);
      this.bufBase = keepFrom;
    }

    const pending: StreamCellJudgment[] = [];
    for (let i = Math.max(baseIndex, this.finalizedCount); i < this.receivedCount; i++) {
      pending.push(this.snapshot(i));
    }

    return {
      baseIndex,
      pending,
      finalized,
      received: this.receivedCount,
      finalizedCount: this.finalizedCount,
      pendingCount: this.receivedCount - this.finalizedCount,
      retainedAmplitudes: this.ampBuf.length,
    };
  }

  /** 查询某个单元的最新判决。单元尚未到达（下标 ≥ 已接收数）时返回 undefined。 */
  getCell(index: number): StreamCellJudgment | undefined {
    if (!Number.isInteger(index) || index < 0) {
      return undefined;
    }
    if (index >= this.receivedCount) {
      return undefined;
    }
    return this.snapshot(index);
  }

  status(): SessionStatus {
    return {
      geometry: { ...this.geometry },
      alpha: this.alpha,
      n: this.n,
      received: this.receivedCount,
      finalizedCount: this.finalizedCount,
      pendingCount: this.receivedCount - this.finalizedCount,
      retainedAmplitudes: this.ampBuf.length,
    };
  }

  /** 全局位置 p（前 p 个幅度之和）处的前缀和；调用方保证 p 落在保留窗口内。 */
  private prefixAt(p: number): number {
    return this.prefixBuf[p - this.bufBase];
  }

  private snapshot(index: number): StreamCellJudgment {
    return {
      index,
      threshold: this.thresholds[index],
      detection: this.detections[index],
      invalid: this.invalids[index],
      final: this.finals[index],
      revision: this.revisions[index],
    };
  }
}

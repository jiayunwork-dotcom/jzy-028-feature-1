import {
  GoneException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CfarError } from './domain/errors';
import { WindowGeometry } from './domain/geometry';
import {
  AppendOutcome,
  SessionStatus,
  StreamCellJudgment,
  StreamingCfarSession,
} from './domain/streaming-session';
import { GeometrySource, resolveGeometrySource } from './geometry-source';
import { ProfileService } from './profile.service';

export interface SessionInfo extends SessionStatus {
  sessionId: string;
  createdAt: number;
  lastAppendAt: number;
  ttlMs: number;
}

interface SessionRecord {
  id: string;
  session: StreamingCfarSession;
  createdAt: number;
  /** 闲置判定只看追加：查询不续命 */
  lastAppendAt: number;
}

interface Tombstone {
  reason: 'closed' | 'expired';
  at: number;
}

/**
 * 持续检测会话的登记处与生命周期管理。
 *
 *  - 多会话并存：各自持有独立的 StreamingCfarSession，几何、进度、
 *    保留的末尾历史互不干扰；
 *  - 显式关闭：close 立即释放会话占有的全部缓冲；
 *  - 闲置回收：超过 ttlMs 没有追加的会话由后台清扫回收（墓碑记为
 *    expired），防止忘记关闭的客户端耗光内存；
 *  - 已关闭/已过期的会话留下有界墓碑（随清扫修剪），后续访问返回
 *    410 Gone，与从未存在过的 404 区分开。
 */
@Injectable()
export class CfarSessionService implements OnModuleInit, OnModuleDestroy {
  /** 闲置会话存活时长（不追加即回收），默认 10 分钟，可用 CFAR_SESSION_TTL_MS 覆盖 */
  ttlMs = Number(process.env.CFAR_SESSION_TTL_MS ?? 10 * 60 * 1000);
  /** 后台清扫周期，默认 60 秒；<=0 表示不开后台清扫（只能手动 sweepExpired） */
  sweepIntervalMs = Number(process.env.CFAR_SESSION_SWEEP_MS ?? 60 * 1000);
  /** 墓碑保留时长：过了这么久连"它曾存在过"也忘掉，之后按 404 处理 */
  tombstoneTtlMs = Number(process.env.CFAR_SESSION_TOMBSTONE_MS ?? 60 * 60 * 1000);
  /** 时钟（测试可替换） */
  now: () => number = () => Date.now();

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tombstones = new Map<string, Tombstone>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly profileService: ProfileService) {}

  onModuleInit(): void {
    if (this.sweepIntervalMs > 0) {
      this.timer = setInterval(() => this.sweepExpired(), this.sweepIntervalMs);
      // 不挡进程退出
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 开一个检测会话：声明窗几何（具名窗规或内联参数，与 /detect 同一套规则）。 */
  create(source: GeometrySource): SessionInfo {
    const geometry: WindowGeometry = resolveGeometrySource(source, this.profileService);
    // 构造时 validateGeometry，非法几何在这里直接 400
    const session = new StreamingCfarSession(geometry);
    const id = randomUUID();
    const at = this.now();
    const record: SessionRecord = { id, session, createdAt: at, lastAppendAt: at };
    this.sessions.set(id, record);
    return this.infoOf(record);
  }

  /** 追加一批幅度，返回本批新到待定单元与因本批而落定的单元。 */
  append(id: string, rawAmplitudes: unknown): AppendOutcome & { sessionId: string } {
    const record = this.require(id);
    const outcome = record.session.append(rawAmplitudes);
    record.lastAppendAt = this.now();
    return { sessionId: id, ...outcome };
  }

  /** 查询某个单元的最新判决。 */
  getCell(id: string, rawIndex: unknown): StreamCellJudgment {
    const record = this.require(id);
    const index =
      typeof rawIndex === 'string' && /^\d+$/.test(rawIndex)
        ? Number(rawIndex)
        : typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
          ? rawIndex
          : undefined;
    if (index === undefined) {
      throw new CfarError('cell index must be a non-negative integer');
    }
    const cell = record.session.getCell(index);
    if (cell === undefined) {
      throw new NotFoundException(
        `cell ${index} has not arrived in session ${id} (received ${record.session.status().received})`,
      );
    }
    return cell;
  }

  /** 会话状态：几何、进度、当前保留的末尾历史量。 */
  status(id: string): SessionInfo {
    return this.infoOf(this.require(id));
  }

  /** 显式关闭：立即释放会话占有的内存，留墓碑。 */
  close(id: string): { sessionId: string; closed: true } {
    const record = this.require(id);
    this.sessions.delete(record.id);
    this.tombstones.set(record.id, { reason: 'closed', at: this.now() });
    return { sessionId: record.id, closed: true };
  }

  /** 回收闲置会话并修剪过期墓碑。后台定时调用，测试也可直接调用。 */
  sweepExpired(): { expired: string[] } {
    const at = this.now();
    const expired: string[] = [];
    for (const [id, record] of this.sessions) {
      if (at - record.lastAppendAt > this.ttlMs) {
        this.sessions.delete(id);
        this.tombstones.set(id, { reason: 'expired', at });
        expired.push(id);
      }
    }
    for (const [id, stone] of this.tombstones) {
      if (at - stone.at > this.tombstoneTtlMs) {
        this.tombstones.delete(id);
      }
    }
    return { expired };
  }

  /** 当前存活会话数（观测/测试用）。 */
  get activeCount(): number {
    return this.sessions.size;
  }

  private require(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (record !== undefined) {
      return record;
    }
    const stone = this.tombstones.get(id);
    if (stone !== undefined) {
      throw new GoneException(`session ${id} was ${stone.reason}; open a new session`);
    }
    throw new NotFoundException(`unknown session: ${id}`);
  }

  private infoOf(record: SessionRecord): SessionInfo {
    return {
      sessionId: record.id,
      ...record.session.status(),
      createdAt: record.createdAt,
      lastAppendAt: record.lastAppendAt,
      ttlMs: this.ttlMs,
    };
  }
}

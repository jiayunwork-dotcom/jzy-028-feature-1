import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CellEvent,
  SessionView,
  StreamingCfarSession,
} from './domain/streaming-detector';
import { CfarError } from './domain/errors';
import { ProfileService } from './profile.service';
import { resolveWindowSpec, WindowSpecInput } from './window-spec';

export interface SessionServiceOptions {
  /** 会话闲置多久（毫秒）后自动过期回收；<=0 表示不做自动过期。 */
  idleTtlMs: number;
  /** 同时存活的会话数上限，防止忘记关会话把内存耗光。 */
  maxSessions: number;
  clock?: () => number;
}

export interface SessionResult {
  /** 查询单元的最新判决；'forgotten' 为已随历史裁剪、'future' 为该下标尚未追加。 */
  kind: 'result' | 'forgotten' | 'future';
  index: number;
  state?: 'settled' | 'invalid';
  threshold?: number | null;
  detection?: boolean;
  final?: boolean;
  retroactive?: boolean;
}

export interface AppendOutcome {
  sessionId: string;
  events: CellEvent[];
  /** 本批落定（含追溯重判与终态无效）的单元下标，便于调用方只消费变化。 */
  finalized: number[];
  session: SessionView;
}

interface SessionEntry {
  session: StreamingCfarSession;
  lastTouched: number;
}

/** 显式关闭/过期的会话墓碑：继续追加时明确拒绝，而不是被当成新会话静默吞掉。 */
interface Tombstone {
  reason: 'closed' | 'expired';
  at: number;
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private idleTtlMs: number;
  private maxSessions: number;
  private clock: () => number;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly tombstones = new Map<string, Tombstone>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly profileService: ProfileService) {
    const ttl = Number(process.env.SESSION_IDLE_TTL_MS);
    this.idleTtlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 5 * 60 * 1000;
    const max = Number(process.env.SESSION_MAX);
    this.maxSessions = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1000;
    this.clock = () => Date.now();
    this.startSweeper();
  }

  /** 测试构造入口：注入 TTL/上限/时钟（会先拆掉默认的周期清扫定时器）。 */
  static forTesting(
    profileService: ProfileService,
    options: Partial<SessionServiceOptions> = {},
  ): SessionService {
    const service = new SessionService(profileService);
    service.stopSweeper();
    if (options.idleTtlMs !== undefined) {
      (service as unknown as { idleTtlMs: number }).idleTtlMs = options.idleTtlMs;
    }
    if (options.maxSessions !== undefined) {
      (service as unknown as { maxSessions: number }).maxSessions = options.maxSessions;
    }
    if (options.clock !== undefined) {
      (service as unknown as { clock: () => number }).clock = options.clock;
    }
    service.startSweeper();
    return service;
  }

  onModuleDestroy(): void {
    this.stopSweeper();
  }

  private stopSweeper(): void {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSweeper(): void {
    if (this.idleTtlMs > 0) {
      const period = Math.max(1000, Math.floor(this.idleTtlMs / 2));
      this.sweeper = setInterval(() => this.sweepExpired(), period);
      this.sweeper.unref?.();
    }
  }

  /** 开一个持续检测会话，声明本次会话的窗几何（具名窗规或内联）。 */
  create(spec: WindowSpecInput): { sessionId: string; session: SessionView } {
    this.sweepExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new ConflictException(
        `session limit reached: at most ${this.maxSessions} concurrent detection sessions; close idle sessions first`,
      );
    }
    // 非法几何由 resolveWindowSpec / validateGeometry 直接拒绝（400/404）。
    const session = new StreamingCfarSession(resolveWindowSpec(spec, this.profileService), this.clock);
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { session, lastTouched: this.clock() });
    this.tombstones.delete(sessionId);
    return { sessionId, session: session.view() };
  }

  /** 向会话追加一批幅度；只返回因这批数据而状态变化的单元事件。 */
  append(sessionId: unknown, amplitudes: unknown): AppendOutcome {
    const id = this.requireSessionId(sessionId);
    const entry = this.requireOpenSession(id);
    const events = entry.session.append(amplitudes);
    entry.lastTouched = this.clock();
    return {
      sessionId: id,
      events,
      finalized: events.filter((e) => e.final).map((e) => e.index),
      session: entry.session.view(),
    };
  }

  /** 查询某个单元的最新判决（只覆盖仍在末尾保留窗口内的单元）。 */
  result(sessionId: unknown, index: unknown): SessionResult {
    const id = this.requireSessionId(sessionId);
    const entry = this.requireOpenSession(id);
    const cellIndex = requireCellIndex(index);
    const outcome = entry.session.resultAt(cellIndex);
    entry.lastTouched = this.clock();
    if (outcome === 'forgotten') {
      return { kind: 'forgotten', index: cellIndex };
    }
    if (outcome === 'future') {
      return { kind: 'future', index: cellIndex };
    }
    return { kind: 'result', index: cellIndex, ...outcome };
  }

  view(sessionId: unknown): SessionView & { sessionId: string } {
    const id = this.requireSessionId(sessionId);
    const entry = this.requireOpenSession(id);
    return { sessionId: id, ...entry.session.view() };
  }

  /**
   * 显式关闭：先把右边缘仍暂定的单元按一趟式语义落定为终态无效（随关闭响应返回），
   * 再释放该会话占有的全部历史内存。
   */
  close(sessionId: unknown): { sessionId: string; events: CellEvent[] } {
    const id = this.requireSessionId(sessionId);
    const entry = this.requireOpenSession(id);
    const events = entry.session.close();
    this.sessions.delete(id);
    this.tombstones.set(id, { reason: 'closed', at: this.clock() });
    return { sessionId: id, events };
  }

  /** 回收所有超过闲置 TTL 的会话（其未交付的暂定结果随之作废）。 */
  sweepExpired(): number {
    if (this.idleTtlMs <= 0) {
      return 0;
    }
    const now = this.clock();
    let expired = 0;
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastTouched >= this.idleTtlMs) {
        this.sessions.delete(id);
        this.tombstones.set(id, { reason: 'expired', at: now });
        expired += 1;
      }
    }
    // 墓碑同样只保留一个 TTL 窗口，避免墓碑本身无限增长。
    for (const [id, stone] of this.tombstones) {
      if (now - stone.at >= this.idleTtlMs) {
        this.tombstones.delete(id);
      }
    }
    return expired;
  }

  private requireSessionId(sessionId: unknown): string {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new CfarError('sessionId must be a non-empty string');
    }
    return sessionId;
  }

  private requireOpenSession(id: string): SessionEntry {
    this.sweepExpired();
    const stone = this.tombstones.get(id);
    if (stone !== undefined) {
      throw new GoneException(
        stone.reason === 'closed'
          ? `detection session ${id} has been closed`
          : `detection session ${id} has expired after idle timeout`,
      );
    }
    const entry = this.sessions.get(id);
    if (entry === undefined) {
      throw new NotFoundException(`unknown detection session: ${id}`);
    }
    return entry;
  }
}

function requireCellIndex(index: unknown): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new CfarError('cell index must be a non-negative integer');
  }
  return index;
}

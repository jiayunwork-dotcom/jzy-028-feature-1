import { GoneException, NotFoundException } from '@nestjs/common';
import { CfarError } from '../../src/cfar/domain/errors';
import { runCaCfar } from '../../src/cfar/domain/detector';
import { ProfileService } from '../../src/cfar/profile.service';
import { CfarSessionService } from '../../src/cfar/session.service';

const GEO = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };

function makeService(): CfarSessionService {
  const svc = new CfarSessionService(new ProfileService());
  // 单测不开后台定时器（onModuleInit 不会被触发），全靠手动 sweepExpired
  return svc;
}

describe('CfarSessionService —— 开会话与追加', () => {
  test('具名窗规与内联几何都能开会话；非法声明被拒', () => {
    const svc = makeService();
    const byProfile = svc.create({ profileName: 'standard' });
    expect(byProfile.geometry).toEqual({ guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 });
    expect(byProfile.n).toBe(16);
    const byInline = svc.create(GEO);
    expect(byInline.sessionId).not.toBe(byProfile.sessionId);

    expect(() => svc.create({})).toThrow(CfarError); // 什么都没给
    expect(() => svc.create({ profileName: 'standard', ...GEO })).toThrow(CfarError); // 两边都给
    expect(() => svc.create({ profileName: 'ghost' })).toThrow(NotFoundException); // 未登记窗规
    expect(() => svc.create({ guardCells: 0, referenceCellsPerSide: 0, pfa: 0.5 })).toThrow(CfarError); // 窗长 0
    expect(() => svc.create({ guardCells: -1, referenceCellsPerSide: 2, pfa: 0.5 })).toThrow(CfarError);
    expect(() => svc.create({ guardCells: 0, referenceCellsPerSide: 2, pfa: 1.5 })).toThrow(CfarError);
  });

  test('追加返回只含本批新到待定单元与本批落定单元，不整条重扫历史', () => {
    const svc = makeService();
    const { sessionId } = svc.create(GEO);
    const line = [0.4, 0.5, 0.3, 0.6, 0.4, 0.5, 0.3, 0.6, 0.4, 0.5];
    svc.append(sessionId, line.slice(0, 6));
    const second = svc.append(sessionId, line.slice(6));
    // 第二批 4 个点：落定前沿推进 4 格，finalized 恰好 4 个，绝不是全部 10 个
    expect(second.finalized).toHaveLength(4);
    expect(second.finalized.map((c) => c.index)).toEqual([3, 4, 5, 6]);
    expect(second.received).toBe(10);
    // 与单趟一致
    const oneShot = runCaCfar(line, GEO);
    for (const cell of second.finalized) {
      expect(cell.threshold).toBe(oneShot.thresholds[cell.index]);
    }
  });

  test('多会话并存：几何、进度、保留历史互不干扰', () => {
    const svc = makeService();
    const a = svc.create({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 });
    const b = svc.create({ guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-6 });
    const lineA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const lineB = new Array(40).fill(0.5);

    // 交错追加：A 的节奏不影响 B 的判决
    svc.append(a.sessionId, lineA.slice(0, 4));
    svc.append(b.sessionId, lineB.slice(0, 30));
    svc.append(a.sessionId, lineA.slice(4));
    svc.append(b.sessionId, lineB.slice(30));

    const oneShotA = runCaCfar(lineA, { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 });
    const oneShotB = runCaCfar(lineB, { guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-6 });
    for (let i = 0; i < lineA.length; i++) {
      expect(svc.getCell(a.sessionId, i).threshold).toBe(oneShotA.thresholds[i]);
    }
    for (let i = 0; i < lineB.length; i++) {
      expect(svc.getCell(b.sessionId, i).threshold).toBe(oneShotB.thresholds[i]);
    }
    // 各自保留的末尾历史只随自己的几何变化
    expect(svc.status(a.sessionId).retainedAmplitudes).toBe(2 * (1 + 2));
    expect(svc.status(b.sessionId).retainedAmplitudes).toBe(2 * (2 + 8));
  });
});

describe('CfarSessionService —— 关闭、过期与拒绝', () => {
  test('不存在的会话：追加/查询/关闭一律 404', () => {
    const svc = makeService();
    expect(() => svc.append('no-such-id', [1])).toThrow(NotFoundException);
    expect(() => svc.getCell('no-such-id', 0)).toThrow(NotFoundException);
    expect(() => svc.status('no-such-id')).toThrow(NotFoundException);
    expect(() => svc.close('no-such-id')).toThrow(NotFoundException);
  });

  test('已关闭的会话：追加/查询/再关闭一律 410，且内存已释放', () => {
    const svc = makeService();
    const { sessionId } = svc.create(GEO);
    svc.append(sessionId, [0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(svc.activeCount).toBe(1);
    svc.close(sessionId);
    expect(svc.activeCount).toBe(0);
    expect(() => svc.append(sessionId, [0.6])).toThrow(GoneException);
    expect(() => svc.getCell(sessionId, 0)).toThrow(GoneException);
    expect(() => svc.status(sessionId)).toThrow(GoneException);
    expect(() => svc.close(sessionId)).toThrow(GoneException);
  });

  test('闲置会话被清扫回收：之后追加按 410 拒绝', () => {
    const svc = makeService();
    let clock = 1_000_000;
    svc.now = () => clock;
    svc.ttlMs = 60_000;

    const idle = svc.create(GEO);
    const busy = svc.create(GEO);
    svc.append(idle.sessionId, [0.1, 0.2]);
    svc.append(busy.sessionId, [0.1, 0.2]);

    clock += 30_000;
    svc.append(busy.sessionId, [0.3]); // busy 续命（追加才续命）
    clock += 45_000; // idle 已 75s 未追加 → 过期；busy 距上次追加 45s → 存活

    const { expired } = svc.sweepExpired();
    expect(expired).toEqual([idle.sessionId]);
    expect(svc.activeCount).toBe(1);
    expect(() => svc.append(idle.sessionId, [0.9])).toThrow(GoneException);
    expect(() => svc.append(idle.sessionId, [0.9])).toThrow(/expired/);
    expect(() => svc.append(busy.sessionId, [0.9])).not.toThrow();
  });

  test('墓碑有界：过期墓碑再搁 tombstoneTtlMs 后被彻底遗忘，按 404 处理', () => {
    const svc = makeService();
    let clock = 0;
    svc.now = () => clock;
    svc.ttlMs = 100;
    svc.tombstoneTtlMs = 1_000;

    const { sessionId } = svc.create(GEO);
    clock += 200;
    svc.sweepExpired();
    expect(() => svc.status(sessionId)).toThrow(GoneException); // 墓碑还在 → 410

    clock += 2_000;
    svc.sweepExpired(); // 墓碑也被修剪
    expect(() => svc.status(sessionId)).toThrow(NotFoundException); // 彻底遗忘 → 404
  });

  test('非法单元下标查询被拒（400），未到达的单元 404', () => {
    const svc = makeService();
    const { sessionId } = svc.create(GEO);
    svc.append(sessionId, [0.1, 0.2, 0.3]);
    expect(() => svc.getCell(sessionId, -1)).toThrow(CfarError);
    expect(() => svc.getCell(sessionId, 1.5)).toThrow(CfarError);
    expect(() => svc.getCell(sessionId, 'abc')).toThrow(CfarError);
    expect(() => svc.getCell(sessionId, 3)).toThrow(NotFoundException); // 还没追加到
    expect(svc.getCell(sessionId, '2').index).toBe(2); // 字符串数字可用
  });
});

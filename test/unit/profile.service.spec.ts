import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProfileService } from '../../src/cfar/profile.service';

describe('ProfileService —— 具名窗规内存存取', () => {
  test('启动时载入种子窗规', () => {
    const svc = new ProfileService();
    expect(svc.has('standard')).toBe(true);
    expect(svc.has('stringent')).toBe(true);
    const standard = svc.get('standard');
    expect(standard).toEqual({ guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 });
    const names = svc.list().map((p) => p.name);
    expect(names).toContain('standard');
    expect(names).toContain('stringent');
  });

  test('运行期可追加且立即可取；不落库（新实例看不到追加项）', () => {
    const svc = new ProfileService();
    const created = svc.register('custom', {
      guardCells: 0,
      referenceCellsPerSide: 4,
      pfa: 0.01,
    });
    expect(created.name).toBe('custom');
    expect(svc.get('custom').referenceCellsPerSide).toBe(4);
    expect(new ProfileService().has('custom')).toBe(false);
  });

  test('重名追加抛 Conflict(409)', () => {
    const svc = new ProfileService();
    expect(() =>
      svc.register('standard', { guardCells: 0, referenceCellsPerSide: 2, pfa: 0.01 }),
    ).toThrow(ConflictException);
  });

  test('点到没登记的窗规抛 NotFound(404)', () => {
    const svc = new ProfileService();
    expect(() => svc.get('nope')).toThrow(NotFoundException);
  });

  test('登记非法几何被拒', () => {
    const svc = new ProfileService();
    expect(() =>
      svc.register('bad', { guardCells: 1, referenceCellsPerSide: 0, pfa: 0.01 }),
    ).toThrow(/referenceCellsPerSide/);
    expect(() =>
      svc.register('bad', { guardCells: 1, referenceCellsPerSide: 2, pfa: 1 }),
    ).toThrow(/pfa/);
  });
});

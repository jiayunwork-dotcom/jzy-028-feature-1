import { CfarError } from '../../src/cfar/domain/errors';
import {
  isWindowAvailable,
  leftReferenceIndices,
  referenceSlices,
  rightReferenceIndices,
} from '../../src/cfar/domain/reference-window';

describe('reference-window —— 参考窗切片', () => {
  test('参考下标严格跳过保护单元和 CUT：guard=2, perSide=3, cut=10', () => {
    expect(leftReferenceIndices(10, 2, 3)).toEqual([7, 6, 5]); // 保护 8,9；CUT 10
    expect(rightReferenceIndices(10, 2, 3)).toEqual([13, 14, 15]); // 保护 11,12
  });

  test('guard=0 时参考紧邻 CUT，仍不包含 CUT 本身', () => {
    expect(leftReferenceIndices(10, 0, 3)).toEqual([9, 8, 7]);
    expect(rightReferenceIndices(10, 0, 3)).toEqual([11, 12, 13]);
  });

  test('两侧参考凑不齐时 isWindowAvailable=false：不许补零', () => {
    const length = 10; // 下标 0..9, guard=1, perSide=2 -> 需要 cut∈[3,6]
    expect(isWindowAvailable(0, length, 1, 2)).toBe(false);
    expect(isWindowAvailable(2, length, 1, 2)).toBe(false);
    expect(isWindowAvailable(3, length, 1, 2)).toBe(true);
    expect(isWindowAvailable(6, length, 1, 2)).toBe(true);
    expect(isWindowAvailable(7, length, 1, 2)).toBe(false);
    expect(isWindowAvailable(9, length, 1, 2)).toBe(false);
  });

  test('referenceSlices 在边缘返回 null（不是零填充数组）', () => {
    const amps = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(referenceSlices(amps, 0, 1, 2)).toBeNull();
    expect(referenceSlices(amps, 9, 1, 2)).toBeNull();
    const slices = referenceSlices(amps, 4, 1, 2);
    expect(slices).not.toBeNull();
    expect(slices!.left).toEqual([1, 1]);
    expect(slices!.right).toEqual([1, 1]);
  });

  test('合成数据卡住实现错误：保护单元和 CUT 的幅度进不了参考切片', () => {
    // cut=4, guard=1, perSide=2：保护是下标 3、5，CUT 是 4。
    // 只在保护单元与 CUT 灌极大值；若实现错误把它们算进参考，切片里就会出现 888/999。
    const amps = [1, 1, 1, 888, 999, 888, 1, 1];
    const slices = referenceSlices(amps, 4, 1, 2);
    expect(slices).not.toBeNull();
    expect(slices!.left).toEqual([1, 1]); // 下标 1,2
    expect(slices!.right).toEqual([1, 1]); // 下标 6,7
    expect([...slices!.left, ...slices!.right]).not.toContain(888);
    expect([...slices!.left, ...slices!.right]).not.toContain(999);
  });

  test('cut 越界抛领域错误', () => {
    expect(() => referenceSlices([1, 2, 3], -1, 0, 1)).toThrow(CfarError);
    expect(() => referenceSlices([1, 2, 3], 3, 0, 1)).toThrow(CfarError);
  });
});

import { CfarError } from './domain/errors';
import { validateGeometry, WindowGeometry } from './domain/geometry';
import { ProfileService } from './profile.service';

/**
 * 窗几何声明：要么点一个已登记的具名窗规（profileName），
 * 要么当次内联给 guardCells/referenceCellsPerSide/pfa；
 * 两者必须二选一，非法时抛 CfarError（400），未登记窗名由 ProfileService 抛 404。
 */
export interface WindowSpecInput {
  profileName?: unknown;
  guardCells?: unknown;
  referenceCellsPerSide?: unknown;
  pfa?: unknown;
}

export function resolveWindowSpec(
  spec: WindowSpecInput | null | undefined,
  profileService: ProfileService,
): WindowGeometry {
  const input = spec ?? {};
  const hasInline =
    input.guardCells !== undefined ||
    input.referenceCellsPerSide !== undefined ||
    input.pfa !== undefined;
  const hasProfileName = input.profileName !== undefined;

  if (hasProfileName && hasInline) {
    throw new CfarError(
      'specify either profileName or inline geometry (guardCells/referenceCellsPerSide/pfa), not both',
    );
  }
  if (!hasProfileName && !hasInline) {
    throw new CfarError(
      'missing window geometry: provide profileName or guardCells/referenceCellsPerSide/pfa',
    );
  }

  if (hasProfileName) {
    if (typeof input.profileName !== 'string' || input.profileName.trim() === '') {
      throw new CfarError('profileName must be a non-empty string');
    }
    // 未登记的名字由 ProfileService 抛 NotFoundException(404)
    return profileService.get(input.profileName);
  }

  return validateGeometry({
    guardCells: input.guardCells,
    referenceCellsPerSide: input.referenceCellsPerSide,
    pfa: input.pfa,
  } as Partial<WindowGeometry>);
}

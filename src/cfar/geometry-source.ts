import { CfarError } from './domain/errors';
import { WindowGeometry } from './domain/geometry';
import { ProfileService } from './profile.service';

/** 窗几何来源：具名窗规 或 内联参数，二选一。/detect 与开会话共用。 */
export interface GeometrySource {
  profileName?: unknown;
  guardCells?: unknown;
  referenceCellsPerSide?: unknown;
  pfa?: unknown;
}

/**
 * 解析窗几何来源：
 *  - 给 profileName：查已登记窗规，未登记由 ProfileService 抛 NotFoundException(404)；
 *  - 给内联参数：原样返回，具体合法性由领域层 validateGeometry 在使用点校验；
 *  - 两者都给 / 都不给：400。
 */
export function resolveGeometrySource(
  dto: GeometrySource,
  profileService: ProfileService,
): WindowGeometry {
  const hasInline =
    dto.guardCells !== undefined ||
    dto.referenceCellsPerSide !== undefined ||
    dto.pfa !== undefined;
  const hasProfileName = dto.profileName !== undefined;

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
    if (typeof dto.profileName !== 'string' || dto.profileName.trim() === '') {
      throw new CfarError('profileName must be a non-empty string');
    }
    // 未登记的名字由 ProfileService 抛 NotFoundException(404)
    return profileService.get(dto.profileName);
  }

  return {
    guardCells: dto.guardCells,
    referenceCellsPerSide: dto.referenceCellsPerSide,
    pfa: dto.pfa,
  } as unknown as WindowGeometry; // 具体合法性在领域层 validateGeometry 中校验
}

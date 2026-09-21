import { Injectable } from '@nestjs/common';
import { CfarError } from './domain/errors';
import { DetectionResult, runCaCfar } from './domain/detector';
import { WindowGeometry } from './domain/geometry';
import { DetectRequestDto } from './dto/requests';
import { ProfileService } from './profile.service';

@Injectable()
export class CfarService {
  constructor(private readonly profileService: ProfileService) {}

  /**
   * 一趟滑窗检测。窗几何来自具名窗规或当次请求内联参数。
   * 累计和只在 runCaCfar 内部存活，算完即随该趟释放。
   */
  detect(dto: DetectRequestDto): DetectionResult {
    const geometry = this.resolveGeometry(dto);
    return runCaCfar(dto.amplitudes, geometry);
  }

  private resolveGeometry(dto: DetectRequestDto): WindowGeometry {
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
      return this.profileService.get(dto.profileName);
    }

    return {
      guardCells: dto.guardCells,
      referenceCellsPerSide: dto.referenceCellsPerSide,
      pfa: dto.pfa,
    } as unknown as WindowGeometry; // 具体合法性在领域层 validateGeometry 中校验
  }
}

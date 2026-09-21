import { Injectable } from '@nestjs/common';
import { DetectionResult, runCaCfar } from './domain/detector';
import { DetectRequestDto } from './dto/requests';
import { ProfileService } from './profile.service';
import { resolveWindowSpec } from './window-spec';

@Injectable()
export class CfarService {
  constructor(private readonly profileService: ProfileService) {}

  /**
   * 一趟滑窗检测。窗几何来自具名窗规或当次请求内联参数。
   * 累计和只在 runCaCfar 内部存活，算完即随该趟释放。
   */
  detect(dto: DetectRequestDto): DetectionResult {
    const geometry = resolveWindowSpec(dto, this.profileService);
    return runCaCfar(dto.amplitudes, geometry);
  }
}

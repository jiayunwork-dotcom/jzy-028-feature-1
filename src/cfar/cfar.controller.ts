import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CfarService } from './cfar.service';
import { CfarError } from './domain/errors';
import { DetectRequestDto, RegisterProfileRequestDto } from './dto/requests';
import { ProfileService } from './profile.service';

@Controller()
export class CfarController {
  constructor(
    private readonly cfarService: CfarService,
    private readonly profileService: ProfileService,
  ) {}

  /** 提交一条距离线，拿回逐单元阈值、检出标记、无效标记及实际使用的 α、N。 */
  @Post('detect')
  @HttpCode(200)
  detect(@Body() body: DetectRequestDto) {
    return this.cfarService.detect(body ?? {});
  }

  /** 追加一条具名窗规到内存。 */
  @Post('profiles')
  @HttpCode(201)
  registerProfile(@Body() body: RegisterProfileRequestDto) {
    const request = body ?? {};
    if (typeof request.name !== 'string' || request.name.trim() === '') {
      throw new CfarError('profile name must be a non-empty string');
    }
    return this.profileService.register(request.name, {
      guardCells: request.guardCells,
      referenceCellsPerSide: request.referenceCellsPerSide,
      pfa: request.pfa,
    });
  }

  /** 列出当前内存中的全部窗规。 */
  @Get('profiles')
  listProfiles() {
    return { profiles: this.profileService.list() };
  }
}

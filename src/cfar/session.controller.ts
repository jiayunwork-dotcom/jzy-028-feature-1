import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AppendRequestDto, CreateSessionRequestDto } from './dto/requests';
import { CfarSessionService } from './session.service';

/**
 * 持续检测会话接口：先开会话声明窗几何，再分批追加幅度，
 * 每批只返回"因本批到达而变得可以下判"的单元，历史绝不整条重扫。
 */
@Controller('sessions')
export class SessionController {
  constructor(private readonly sessionService: CfarSessionService) {}

  /** 开会话：{ profileName } 或 { guardCells, referenceCellsPerSide, pfa } 二选一。 */
  @Post()
  create(@Body() body: CreateSessionRequestDto) {
    return this.sessionService.create(body ?? {});
  }

  /**
   * 追加一批幅度。响应只含：
   *  - pending：本批新到、右窗未齐而暂标无效的单元；
   *  - finalized：因本批到达而落定的单元（含对之前 pending 单元的追溯重判）。
   */
  @Post(':id/append')
  @HttpCode(200)
  append(@Param('id') id: string, @Body() body: AppendRequestDto) {
    return this.sessionService.append(id, (body ?? {}).amplitudes);
  }

  /** 会话状态：几何、追加进度、当前保留的末尾历史量。 */
  @Get(':id')
  status(@Param('id') id: string) {
    return this.sessionService.status(id);
  }

  /** 查询某个单元的最新判决（含是否落定、第几次判定）。 */
  @Get(':id/cells/:index')
  cell(@Param('id') id: string, @Param('index') index: string) {
    return this.sessionService.getCell(id, index);
  }

  /** 显式关闭会话并释放其内存。 */
  @Delete(':id')
  @HttpCode(200)
  close(@Param('id') id: string) {
    return this.sessionService.close(id);
  }
}

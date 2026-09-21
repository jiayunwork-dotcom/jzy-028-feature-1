import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AppendSessionRequestDto, CreateSessionRequestDto } from './dto/requests';
import { SessionService } from './session.service';

/**
 * 持续检测会话 API：
 *   POST   /sessions                 开会话（声明窗几何，具名或内联）
 *   POST   /sessions/:id/append      追加一批幅度，只回本批状态发生变化的单元
 *   GET    /sessions/:id/results/:index  查询某单元最新判决
 *   GET    /sessions/:id             查看会话状态（含内存占用指标）
 *   DELETE /sessions/:id             显式关闭并释放内存（右边缘暂定单元随响应落定）
 */
@Controller('sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateSessionRequestDto) {
    return this.sessionService.create(body ?? {});
  }

  @Post(':id/append')
  @HttpCode(200)
  append(
    @Param('id') id: string,
    @Body() body: AppendSessionRequestDto,
  ) {
    return this.sessionService.append(id, (body ?? {}).amplitudes);
  }

  @Get(':id/results/:index')
  result(@Param('id') id: string, @Param('index') index: string) {
    return this.sessionService.result(id, Number(index));
  }

  @Get(':id')
  view(@Param('id') id: string) {
    return this.sessionService.view(id);
  }

  @Delete(':id')
  @HttpCode(200)
  close(@Param('id') id: string) {
    return this.sessionService.close(id);
  }
}

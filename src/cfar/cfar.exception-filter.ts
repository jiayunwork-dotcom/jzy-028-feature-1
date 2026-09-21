import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { CfarError } from './domain/errors';

/**
 * 把纯算法层抛出的 CfarError 统一映射成 HTTP 400。
 * Nest 自带的 HttpException（如未知窗规 404、重名 409）不走这里。
 */
@Catch(CfarError)
export class CfarExceptionFilter implements ExceptionFilter {
  catch(exception: CfarError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: exception.message,
    });
  }
}

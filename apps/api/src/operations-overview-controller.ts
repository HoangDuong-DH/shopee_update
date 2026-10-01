import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { OperationsOverviewService } from './operations-overview-service.js';

@Controller('v1/operations')
export class OperationsOverviewController {
  constructor(@Inject(OperationsOverviewService) private readonly overview: OperationsOverviewService) {}
  @Get('overview') get(@Query() query: unknown, @Res({ passthrough: true }) reply: any) {
    reply.header('Cache-Control', 'private, no-store');
    return this.overview.get(query);
  }
}

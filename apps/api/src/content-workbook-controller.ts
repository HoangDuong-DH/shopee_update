import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ContentWorkbookService } from './content-workbook-service.js';
@Controller('v1/content-workbooks')
export class ContentWorkbookController {
  constructor(@Inject(ContentWorkbookService) readonly service: ContentWorkbookService) {}
  @Get(':id') inspect(@Param('id') id: string, @Query('headerRow') row?: string): ReturnType<ContentWorkbookService['inspect']> {
    return this.service.inspect(id, row === undefined ? 1 : Number(row));
  }
  @Post('rows') rows(@Body() raw: unknown): ReturnType<ContentWorkbookService['rows']> {
    return this.service.rows(raw);
  }
}

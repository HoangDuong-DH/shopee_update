import { Body, Controller, Inject, Post } from '@nestjs/common';
import { BulkProductEditService } from './bulk-product-edit-service.js';

@Controller('v1/products/bulk-edit')
export class BulkProductEditController {
  constructor(@Inject(BulkProductEditService) private readonly service: BulkProductEditService) {}
  @Post('preview') preview(@Body() input: unknown): ReturnType<BulkProductEditService['preview']> { return this.service.preview(input); }
  @Post('apply') apply(@Body() input: unknown): ReturnType<BulkProductEditService['apply']> { return this.service.apply(input); }
}

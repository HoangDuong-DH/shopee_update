import { Body, Controller, Inject, Post } from '@nestjs/common';
import { SellerKnowledgeDraftService } from './seller-knowledge-draft-service.js';

@Controller('v1/seller-knowledge')
export class SellerKnowledgeDraftController {
  constructor(
    @Inject(SellerKnowledgeDraftService) private readonly service: SellerKnowledgeDraftService,
  ) {}
  @Post('draft-recommendations') recommend(@Body() input: unknown): ReturnType<SellerKnowledgeDraftService['recommend']> {
    return this.service.recommend(input);
  }
  @Post('draft-acceptances') accept(@Body() input: unknown): ReturnType<SellerKnowledgeDraftService['accept']> {
    return this.service.accept(input);
  }
}

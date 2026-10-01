import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { LocalLibraryService } from './local-library-service.js';

@Controller('v1/local-library')
export class LocalLibraryController {
  constructor(@Inject(LocalLibraryService) private readonly library:LocalLibraryService) {}
  @Get('products') products(@Query() query:unknown,@Res({passthrough:true}) reply:any) {
    reply.header('Cache-Control','private, no-store'); return this.library.products(query);
  }
  @Get('imports') imports(@Query() query:unknown,@Res({passthrough:true}) reply:any) {
    reply.header('Cache-Control','private, no-store'); return this.library.imports(query);
  }
}

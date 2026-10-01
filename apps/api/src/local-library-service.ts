import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { localLibraryQuerySchema, type LocalLibraryQuery } from '@shopee/domain';
import { LocalLibraryRepository, type Repository } from '@shopee/persistence';

export class LocalLibraryService {
  private readonly library:LocalLibraryRepository;
  constructor(repo:Repository) { this.library=new LocalLibraryRepository(repo.pool); }
  products(raw:unknown) { return this.read(raw,query=>this.library.products(query)); }
  imports(raw:unknown) { return this.read(raw,query=>this.library.imports(query)); }
  private async read<T>(raw:unknown,load:(query:LocalLibraryQuery)=>Promise<T>):Promise<T> {
    const parsed=localLibraryQuerySchema.safeParse(raw);
    if(!parsed.success) throw new BadRequestException('LOCAL_LIBRARY_QUERY_INVALID');
    try { return await load(parsed.data); }
    catch(error) {
      if(error instanceof Error && error.message==='LOCAL_LIBRARY_CURSOR_INVALID')
        throw new BadRequestException('LOCAL_LIBRARY_CURSOR_INVALID');
      throw new ServiceUnavailableException('LOCAL_LIBRARY_UNAVAILABLE');
    }
  }
}

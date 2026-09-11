import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Inject,
  Module,
  HttpException,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';
import { extname } from 'node:path';
import { BlobStore, Repository } from '@shopee/persistence';
import { makePlan, type Issue, type Scope } from '@shopee/domain';
import { HealthController, DB_PROBE } from './health.js';
import { assembleProduct, productInput } from './product-service.js';
import { connectSandbox } from './connection-service.js';
import { AssistantService, type KnowledgePort } from './assistant-service.js';
import { KnowledgeLibrary } from '@shopee/agent-runtime';
import { InputService } from './input-service.js';
const REPO = Symbol('repository'),
  BLOBS = Symbol('blobs');
const id = (s: string) => z.string().uuid().parse(s);
const fields = z.enum([
  'title',
  'description',
  'gallery',
  'category',
  'brand',
  'attributes',
  'variations',
  'price',
  'stock',
  'logistics',
  'video',
  'sizeChart',
  'identifiers',
  'compliance',
  'fulfillment',
  'publication',
]);
@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse();
    if (error instanceof HttpException)
      return reply.status(error.getStatus()).send(error.getResponse());
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        code: 'INVALID_INPUT',
        message: 'Dữ liệu nhập chưa hợp lệ.',
        fields: error.issues.map((i) => i.path.join('.')),
      });
    const code = error instanceof Error ? error.message : '';
    const inputMessages: Record<string, string> = {
      INPUT_BATCH_REVISION_CONFLICT:
        'Bộ nguồn đã có bản lưu mới hơn. Giữ phần đang làm và mở lại bản mới nhất để đối chiếu.',
      INPUT_BATCH_PRODUCT_KEY_CONFLICT:
        'Thư mục này đang dùng mã listing đã thuộc bộ khác hoặc khác với bản đã lưu. Giữ đúng bộ nguồn để tiếp tục.',
      INPUT_BATCH_PATH_INVALID:
        'Cấu trúc thư mục chưa hợp lệ hoặc vượt giới hạn nhận một lần. Kiểm tra lại thư mục đã chọn.',
      INPUT_BATCH_SELECTION_INVALID:
        'Ảnh hoặc Word đã chọn không thuộc đúng thư mục listing. Kiểm tra lại các tệp trong bộ.',
      INPUT_BATCH_SOURCE_MISMATCH:
        'Một tệp đã nhận chưa khớp nội dung gốc hoặc không còn tồn tại. Chọn lại đúng tệp để đối chiếu.',
      INPUT_BATCH_PRICE_INVALID:
        'Bảng giá, trang tính hoặc bộ giá chưa đọc xong hay không còn khớp lựa chọn. Chọn lại nguồn giá phù hợp.',
    };
    if (Object.hasOwn(inputMessages, code))
      return reply
        .status(code.endsWith('_CONFLICT') ? 409 : 400)
        .send({ code, message: inputMessages[code] });
    if (code === 'PRODUCT_MEMBERSHIP_LOCKED')
      return reply.status(409).send({
        code,
        message:
          'Bộ listing này đã có cấu trúc cố định. Không thể thêm, bớt, thay hoặc đảo SKU; tên và thứ tự phân loại phải giữ nguyên theo bộ đã tiếp nhận.',
      });
    if (code === 'DEADLINE_EXCEEDED')
      return reply.status(504).send({
        code,
        message:
          'Lần kiểm tra đã hết thời gian. Xem lịch sử để biết các bước đã lưu; nguồn và listing được giữ nguyên.',
      });
    const knowledgeMessages: Record<string, string> = {
      KNOWLEDGE_UNKNOWN_DOCUMENT: 'Không tìm thấy tài liệu trong danh mục nguồn.',
      KNOWLEDGE_OPEN_PLATFORM_UNAVAILABLE: 'Kho Open Platform chưa sẵn sàng tại máy chủ.',
      KNOWLEDGE_SELLER_VN_UNAVAILABLE: 'Kho Học viện Shopee VN chưa sẵn sàng tại máy chủ.',
      KNOWLEDGE_SOURCE_NOT_ALLOWED: 'Nguồn này không thuộc danh sách tài liệu Shopee được hỗ trợ.',
      KNOWLEDGE_PATH_OUTSIDE_ROOT: 'Đường dẫn tài liệu nằm ngoài kho đã cấu hình.',
      KNOWLEDGE_DOCUMENT_UNAVAILABLE: 'Tệp tài liệu không còn truy cập được.',
      KNOWLEDGE_DOCUMENT_TOO_LARGE:
        'Tài liệu vượt dung lượng đọc đầy đủ; mở nguồn chính thức để xem.',
      KNOWLEDGE_INTEGRITY_MISMATCH:
        'Tài liệu đã đổi so với bản kê nguồn. Cần kiểm tra lại bản chụp.',
    };
    if (Object.hasOwn(knowledgeMessages, code))
      return reply.status(409).send({ code, message: knowledgeMessages[code] });
    if (
      /^(PLAN_|PRODUCT_REVISION_|SOURCE_REVISION_|STOCK_COMMAND_|JOB_|RECONCILIATION_)/.test(code)
    )
      return reply.status(409).send({ code, message: code });
    if (/^(SOURCE_|ASSET_|NOT_FOUND|INVALID_)/.test(code))
      return reply.status(400).send({ code, message: code });
    return reply.status(503).send({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Dịch vụ chưa sẵn sàng. Dữ liệu đã lưu vẫn được giữ; vui lòng thử lại.',
    });
  }
}
@Controller('v1')
class AppController {
  constructor(
    @Inject(REPO) readonly repo: Repository,
    @Inject(BLOBS) readonly blobs: BlobStore,
    @Inject(AssistantService) readonly assistant: AssistantService,
    @Inject(InputService) readonly input: InputService,
  ) {}
  @Get('input-library') inputLibrary() {
    return this.input.library.library();
  }
  @Get('input-batches') inputBatches() {
    return this.input.library.list();
  }
  @Get('input-batches/:id') async inputBatch(@Param('id') key: string) {
    const record = await this.input.library.get(id(key));
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return record;
  }
  @Post('input-batches') saveInputBatch(@Body() raw: unknown) {
    return this.input.save(raw);
  }
  @Get('assistant/reviews') reviews() {
    return this.assistant.list();
  }
  @Get('assistant/reviews/:id') review(@Param('id') key: string) {
    return this.assistant.get(id(key));
  }
  @Post('assistant/reviews') investigate(@Body() raw: unknown) {
    return this.assistant.review(raw);
  }
  @Post('knowledge/search') searchKnowledge(@Body() raw: unknown) {
    const input = z
      .object({ query: z.string().trim().min(1).max(300) })
      .strict()
      .parse(raw);
    return this.assistant.knowledge.search(input.query, 10);
  }
  @Post('knowledge/read') async readKnowledge(@Body() raw: unknown) {
    const input = z
      .object({
        documentId: z.string().min(1).max(300),
        expectedSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(raw);
    const doc = await this.assistant.knowledge.readDocument(input.documentId);
    if (input.expectedSha256 && input.expectedSha256 !== doc.source.sha256)
      throw new Error('SOURCE_REVISION_CHANGED');
    return doc;
  }
  @Get('status') async status() {
    const r = await this.repo.pool.query(
      "SELECT max(updated_at) AS last_seen FROM worker_heartbeats WHERE updated_at>now()-interval '15 seconds'",
    );
    return {
      productionWrites: false,
      listingExecutor: 'not_configured',
      worker: r.rows[0].last_seen ? 'online' : 'offline',
      version: '0.1.0',
      mode: 'internal',
    };
  }
  @Post('imports') async upload(@Req() req: any, @Res({ passthrough: true }) reply: any) {
    const raw = req.headers['x-file-name'];
    if (typeof raw !== 'string') throw new HttpException({ code: 'FILENAME_REQUIRED' }, 400);
    let filename: string;
    try {
      filename = decodeURIComponent(raw);
    } catch {
      throw new HttpException({ code: 'INVALID_FILENAME' }, 400);
    }
    if (!filename || filename.length > 255 || /[\x00-\x1f/\\]/.test(filename))
      throw new HttpException({ code: 'INVALID_FILENAME' }, 400);
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      throw new HttpException({ code: 'EMPTY_FILE' }, 400);
    const ext = extname(filename).toLowerCase();
    const kind =
      ext === '.xlsx'
        ? 'xlsx'
        : ext === '.docx'
          ? 'docx'
          : ['.png', '.jpg', '.jpeg', '.webp'].includes(ext)
            ? 'image'
            : null;
    if (!kind) throw new HttpException({ code: 'UNSUPPORTED_FILE' }, 400);
    const sha256 = await this.blobs.put(req.body);
    const record = await this.repo.createImport({ sha256, filename, kind, bytes: req.body.length });
    reply.status(202);
    return record;
  }
  @Get('imports') imports() {
    return this.repo.listImports();
  }
  @Get('imports/:id') async imported(@Param('id') key: string) {
    const record = await this.repo.getImport(id(key));
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return record;
  }
  @Get('media/:id') async media(@Param('id') key: string, @Res() reply: any) {
    const record = await this.repo.getImport(id(key));
    if (record?.kind !== 'image' || record.status !== 'ready')
      throw new HttpException({ code: 'NOT_FOUND' }, 404);
    const asset = record.body as { mime: string };
    return reply
      .header('Cache-Control', 'private, max-age=86400')
      .header('X-Content-Type-Options', 'nosniff')
      .type(asset.mime)
      .send(await this.blobs.read(record.sha256));
  }
  @Get('products') products() {
    return this.repo.listProducts();
  }
  @Get('products/:key') async product(@Param('key') key: string) {
    const record = await this.repo.getProduct(key);
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return record;
  }
  @Post('products') async saveProduct(@Body() raw: unknown) {
    const input = productInput.parse(raw);
    return this.repo.saveProduct(await assembleProduct(this.repo, input), input.expectedRevision);
  }
  @Get('shops') async shops() {
    return (
      await this.repo.pool.query(
        'SELECT id,environment,partner_id,shop_id,name,region,revision,capability_revision,state,expires_at,capabilities FROM connections ORDER BY environment,name',
      )
    ).rows.map((r) => ({
      id: r.id,
      name: r.name,
      region: r.region,
      state: r.state,
      tokenExpiresAt: r.expires_at,
      capabilities: r.capabilities,
      scope: {
        environment: r.environment,
        partnerId: r.partner_id,
        shopId: r.shop_id,
        connectionRevision: r.revision,
        capabilityRevision: r.capability_revision,
      },
    }));
  }
  @Get('plans') plans() {
    return this.repo.listPlans();
  }
  @Post('connections/sandbox') connect(@Body() raw: unknown) {
    return connectSandbox(this.repo, raw);
  }
  @Get('plans/:id') async plan(@Param('id') key: string) {
    const record = await this.repo.getPlan(id(key));
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return record;
  }
  @Post('plans') async createPlan(@Body() raw: unknown) {
    const input = z
      .object({
        productKey: z.string().min(1),
        sourceRevision: z.number().int().positive(),
        connectionId: z.string().uuid(),
        operation: z.enum(['create', 'update']),
        itemId: z.string().regex(/^\d+$/).optional(),
        fieldMask: z.array(fields).min(1),
      })
      .parse(raw);
    const product = await this.repo.getProduct(input.productKey, input.sourceRevision);
    if (!product) throw new Error('SOURCE_NOT_FOUND');
    const connection = (await this.shops()).find((s) => s.id === input.connectionId);
    if (!connection) throw new Error('SOURCE_SHOP_NOT_FOUND');
    const issues: Issue[] = [...product.issues];
    const block = (code: string, message: string) =>
      issues.push({ code, severity: 'block', field: 'scope', message, sources: [] });
    if (connection.state !== 'connected')
      block('CONNECTION_REQUIRED', 'Chưa có kết nối Open Platform được kiểm tra từ backend.');
    if (connection.scope.environment === 'production')
      block('PRODUCTION_READ_ONLY', 'Shop thật hiện chỉ được phép nghiên cứu và đọc dữ liệu.');
    block(
      'EXECUTOR_NOT_RELEASED',
      'Luồng ghi Shopee chưa qua nghiệm thu; kế hoạch được lưu để chuẩn bị.',
    );
    if (input.operation === 'update' && !input.itemId)
      block('ITEM_BINDING_REQUIRED', 'Cập nhật cần chọn listing đã liên kết.');
    const plan = makePlan({
      revision: 1,
      scope: connection.scope as Scope,
      productKey: product.productKey,
      sourceRevision: product.revision,
      operation: input.operation,
      itemId: input.itemId,
      fieldMask: [...new Set(input.fieldMask)],
      desired: product,
      stocks: [],
      issues,
    });
    return this.repo.savePlan(plan);
  }
  @Post('plans/:id/submit') async submit(
    @Param('id') key: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) reply: any,
  ) {
    const input = z
      .object({
        revision: z.number().int().positive(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(raw);
    const plan = await this.repo.getPlan(id(key), input.revision);
    if (plan?.scope.environment === 'production')
      throw new HttpException({ code: 'PRODUCTION_READ_ONLY' }, 409);
    const result = await this.repo.submitPlan(key, input.revision, input.fingerprint);
    reply.status(202);
    return result;
  }
  @Get('jobs') jobs() {
    return this.repo.listJobs();
  }
  @Get('jobs/:id') async job(@Param('id') key: string) {
    const job = await this.repo.getJob(id(key));
    if (!job) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return { ...job, events: await this.repo.jobEvents(key) };
  }
  @Post('jobs/:id/:action') control(@Param('id') key: string, @Param('action') action: string) {
    return this.repo.controlJob(id(key), z.enum(['pause', 'resume', 'cancel']).parse(action));
  }
}
export async function createApp(
  repo: Repository,
  blobs: BlobStore,
  origins: string[],
  options: { knowledge?: KnowledgePort } = {},
): Promise<NestFastifyApplication> {
  @Module({
    controllers: [AppController, HealthController],
    providers: [
      { provide: REPO, useValue: repo },
      { provide: BLOBS, useValue: blobs },
      { provide: InputService, useValue: new InputService(repo) },
      { provide: DB_PROBE, useValue: () => repo.probe() },
      {
        provide: AssistantService,
        useValue: new AssistantService(
          repo,
          options.knowledge ??
            new KnowledgeLibrary([
              { corpus: 'open-platform', root: 'knowledge-base/shopee-open-platform' },
              { corpus: 'seller-vn', root: 'knowledge-base/shopee-uni-vn' },
            ]),
        ),
      },
    ],
  })
  class AppModule {}
  const adapter = new FastifyAdapter({ bodyLimit: 64 * 1024 * 1024 });
  adapter
    .getInstance()
    .addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
  adapter.getInstance().addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (
        req.headers['x-app-client'] !== 'internal-workspace' ||
        (req.headers.origin && !origins.includes(req.headers.origin))
      ) {
        reply.status(403).send({ code: 'ORIGIN_NOT_ALLOWED' });
        return;
      }
    }
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn'],
  });
  app.useGlobalFilters(new ApiErrors());
  app.enableShutdownHooks();
  await app.init();
  return app;
}

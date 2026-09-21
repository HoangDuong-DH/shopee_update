import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
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
import { extname, resolve } from 'node:path';
import {
  BlobStore,
  Repository,
  listShopConnections,
  setConnectionDisplayName,
  listSourceCatalogs,
  getSourceCatalog,
  queryCatalogListings,
  getCatalogListing,
  listSourceCatalogEvidence,
  localArchiveKinds,
  localArchiveFlags,
  listLocalArchives,
  setLocalArchive,
} from '@shopee/persistence';
import { makePlan, type Issue, type Scope, type PreparedGateway } from '@shopee/domain';
import { HealthController, DB_PROBE } from './health.js';
import { saveAssembledProduct, productInput, projectProductPriceIssues } from './product-service.js';
import { ConnectionMaintenance } from './connection-maintenance.js';
import { connectSandbox } from './connection-service.js';
import { connectProductionPilot, productionConnectionTarget } from './production-connection-service.js';
import { prepareProductionAuthorization, finishProductionAuthorization, cancelProductionAuthorization,
  productionAuthorizationStatus, productionAuthorizationCookie } from './production-authorization-service.js';
import { AssistantService, type KnowledgePort } from './assistant-service.js';
import { KnowledgeLibrary } from '@shopee/agent-runtime';
import { InputService } from './input-service.js';
import { WorkbenchService } from './workbench-service.js';
import { HandoffService } from './handoff-service.js';
import { SandboxListingService } from './sandbox-listing-service.js';
import { SandboxTrialService } from './sandbox-trial-service.js';
import { ImportPatchService } from './import-patch-service.js';
import { SandboxFieldTrialService } from './sandbox-field-trial-service.js';
import { PreparedBatchService } from './prepared-batch-service.js';
import { createPreparedDispatchTemplate } from './prepared-template.js';
import { ImageQcService } from './image-qc-service.js';
import { sandboxTryoutContext } from './sandbox-tryout-context.js';
import { ProductionPilotService } from './production-pilot-service.js';
import { ProductionBatchService } from './production-batch-service.js';
import { ProductionBatchReviewService } from './production-batch-review-service.js';
import { ProductionPreparationService } from './production-preparation-service.js';
import { ProductionPreparationAutofillService } from './production-preparation-autofill.js';
import { workspaceResetState } from './workspace-reset-state.js';
import { ProductionPreparationExecution } from './production-preparation-execution.js';
import { ProductionPreparationMetadataService, productionPreparationMetadataQuerySchema } from './production-preparation-metadata.js';
import { productionPilotImageService } from './production-pilot-image-service.js';
import { productionPilotSourceRoot } from './production-pilot-source.js';
import { productionPilotWeightReviewFileLookup } from './production-pilot-weight-review.js';
import { SellerKnowledgeService } from './seller-knowledge-service.js';
import { SellerKnowledgeFacts } from './seller-knowledge-facts.js';
import { SellerKnowledgeController } from './seller-knowledge-controller.js';
import { SellerKnowledgeDraftService } from './seller-knowledge-draft-service.js';
import { SellerKnowledgeDraftController } from './seller-knowledge-draft-controller.js';
const REPO = Symbol('repository'),
  BLOBS = Symbol('blobs');
function authorizationBrowserSecret(req: any): string {
  const matches = String(req.headers.cookie ?? '').split(';').map(v => v.trim())
    .filter(v => v.startsWith(productionAuthorizationCookie + '='));
  if (matches.length !== 1) return '';
  const value = matches[0]!.slice(productionAuthorizationCookie.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
function authorizationPage(reply: any, status: string, httpStatus = 200) {
  const messages: Record<string, string> = {
    verified: 'Đã kết nối và xác minh shop đã chọn. Chưa đăng sản phẩm.',
    pending: 'Đang chờ cấp quyền cho shop đã chọn.',
    exchanging: 'Đang xác minh shop. Quay lại ứng dụng để theo dõi kết quả.',
    rejected: 'Chưa kết nối được đúng shop. Quay lại ứng dụng để kiểm tra và chuẩn bị lại.',
    expired: 'Phiên cấp quyền đã hết hạn. Quay lại ứng dụng để chuẩn bị liên kết mới.',
    unknown: 'Chưa xác định được kết quả. Quay lại ứng dụng để kiểm tra kết nối đã lưu.',
    invalid: 'Không nhận được phiên cấp quyền hợp lệ. Mở lại liên kết từ ứng dụng trên cùng trình duyệt.',
  };
  return reply.status(httpStatus).type('text/html; charset=utf-8')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    .send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Kết nối Shopee</title><style>body{font:18px/1.6 system-ui;max-width:650px;margin:60px auto;padding:24px;color:#202923}a{color:#a43a21}</style>
      <h1>Kết nối Shopee</h1><p>${messages[status] ?? messages.invalid}</p>
      <p><a href="/" rel="noreferrer">Quay lại ứng dụng → Công cụ → Kết nối shop</a></p></html>`);
}
const id = (s: string) => z.string().uuid().parse(s);
const productionRouteScope=(raw:unknown)=>z.object({partnerId:z.literal('2010476'),shopId:z.literal('1423724897')}).passthrough().parse(raw ?? {});
const lifecycle = (raw: unknown = 'active') => z.enum(['active','archived','all']).parse(raw);
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
    if(code==='CONNECTION_NOT_FOUND')return reply.status(404).send({code,message:'Không tìm thấy kết nối shop.'});
    if (code.startsWith('LOCAL_ARCHIVE_') || code === 'LOCAL_RESOURCE_ARCHIVED') {
      const messages:Record<string,string>={
        LOCAL_ARCHIVE_IN_USE:'Mục này đang được một đợt đăng hàng sử dụng. Lưu trữ không hủy công việc; hãy xử lý xong đợt đó trước.',
        LOCAL_RESOURCE_ARCHIVED:'Nguồn đã được lưu trữ. Khôi phục nguồn trước khi lưu hoặc chuẩn bị một công việc mới.',
        LOCAL_ARCHIVE_NOT_FOUND:'Không tìm thấy mục cần lưu trữ.',
        LOCAL_ARCHIVE_INVALID:'Thông tin mục cần lưu trữ chưa hợp lệ.',
      };
      return reply.status(code==='LOCAL_ARCHIVE_NOT_FOUND'?404:code==='LOCAL_ARCHIVE_INVALID'?400:409).send({code,message:messages[code]??'Chưa thể thay đổi trạng thái lưu trữ.'});
    }
    if (code.startsWith('KNOWLEDGE_DRAFT_'))
      return reply.status(code.endsWith('NOT_FOUND') ? 404 : 409).send({code,message:'Gợi ý không còn khớp bản nháp, shop hoặc thông tin ngành hiện tại. Đọc lại gợi ý và chọn thông tin đã xác nhận. Nguồn gốc vẫn được giữ nguyên.'});
    if (/^(SELLER_KNOWLEDGE_|KNOWLEDGE_(SYNC|CONNECTION|REQUEST|BATCH|EVIDENCE|CATEGORY|REMOTE|RESPONSE|SCOPE|NOT_FOUND|READ|LOCK|METADATA))/.test(code))
      return reply.status(code.endsWith('NOT_FOUND')?404:409).send({code,message:'Chưa đủ dữ liệu để đối chiếu hoặc kết nối đã thay đổi. Nguồn đã lưu vẫn được giữ; xem trạng thái đồng bộ và thử lại. Chưa thay đổi listing trên Shopee.'});
    // Ordinary batch errors have their own HTTP status and recovery guidance below.
    if (/^(PREPARATION|PRODUCTION_PREPARATION|PRODUCTION_BATCH_REVIEW)_[A-Z0-9_]+$/.test(code)) {
      const messages:Record<string,string>={
        PREPARATION_SOURCE_CHANGED:'Bộ listing đã có phiên bản mới. Kiểm tra lại nguồn để lập bản xem trước mới.',
        PREPARATION_REQUEST_CONFLICT:'Lần chuẩn bị này đã được lưu với dữ liệu khác. Mở kết quả đã lưu hoặc lập lần chuẩn bị mới.',
        PREPARATION_CHILD_REVIEW_REQUIRED:'Một nhóm đang cần đối chiếu. Mở kết quả nhóm đó, xử lý ngoại lệ rồi tiếp tục phần còn lại.',
        PREPARATION_IN_PROGRESS:'Công việc này đang chạy. Kết quả sẽ được cập nhật tự động.',
        PREPARATION_REVIEW_CHANGED:'Bản xem trước đã thay đổi. Tải lại và kiểm tra trước khi tiếp tục.',
        PRODUCTION_PREPARATION_AUTH_REQUIRED:'Kết nối Shopee chưa sẵn sàng hoặc đã hết hạn. Mở Kết nối shop để kiểm tra và kết nối lại, rồi đọc lại thông tin ngành.',
        PRODUCTION_PREPARATION_CONNECTION_CHANGED:'Kết nối shop đã thay đổi trong lúc đọc. Kiểm tra kết nối hiện tại rồi đọc lại thông tin ngành để dùng dữ liệu cùng một phiên.',
        PRODUCTION_PREPARATION_QUERY_INVALID:'Yêu cầu đọc chưa hợp lệ. Kiểm tra lựa chọn ngành, thương hiệu hoặc listing tham khảo rồi đọc lại.',
        PRODUCTION_PREPARATION_READ_FAILED:'Chưa đọc được thông tin từ Shopee. Đọc lại; nếu vẫn lỗi, kiểm tra Kết nối shop và quyền truy cập của ứng dụng trước khi tiếp tục chọn ngành.',
        PRODUCTION_PREPARATION_SHOP_IDENTITY_MISMATCH:'Thông tin trả về chưa xác nhận đúng shop và trạng thái hoạt động. Kiểm tra Kết nối shop rồi đọc lại thông tin ngành.',
        PRODUCTION_PREPARATION_CATEGORY_NOT_SELECTABLE:'Ngành đã chọn không nằm trong danh sách ngành cuối hiện tại. Đọc lại danh sách và chọn ngành phù hợp với sản phẩm.',
        PRODUCTION_PREPARATION_CATEGORY_TREE_INVALID:'Chưa đọc được danh sách ngành đầy đủ và nhất quán. Đọc lại thông tin ngành; nếu vẫn lỗi, nhờ người phụ trách ứng dụng kiểm tra.',
        PRODUCTION_PREPARATION_ATTRIBUTES_INVALID:'Dữ liệu thuộc tính của ngành chưa đầy đủ hoặc không nhất quán. Đọc lại ngành đã chọn trước khi điền thông tin chi tiết.',
        PRODUCTION_PREPARATION_BRANDS_INVALID:'Danh sách thương hiệu trả về chưa hợp lệ hoặc có thông tin mâu thuẫn. Đọc lại thương hiệu của ngành đã chọn.',
        PRODUCTION_PREPARATION_BRAND_CURSOR_INVALID:'Chưa đọc được trang thương hiệu tiếp theo. Đọc lại danh sách thương hiệu từ đầu hoặc tìm theo tên chính xác.',
        PRODUCTION_PREPARATION_BRAND_SEARCH_LIMIT_REACHED:'Đã đạt giới hạn tra cứu nhưng chưa đọc hết danh sách thương hiệu. Chưa thể kết luận thương hiệu không tồn tại; nhờ người phụ trách ứng dụng kiểm tra.',
        PRODUCTION_PREPARATION_CHANNELS_INVALID:'Chưa đọc được danh sách vận chuyển hợp lệ của shop. Đọc lại thông tin shop trước khi chọn đơn vị vận chuyển.',
        PRODUCTION_PREPARATION_CHANNEL_RELATIONS_INVALID:'Chưa xác định được điều kiện kết hợp giữa các kênh vận chuyển. Đọc lại thông tin shop; nếu vẫn lỗi, nhờ người phụ trách ứng dụng kiểm tra.',
        PRODUCTION_PREPARATION_INVENTORY_INVALID:'Danh sách listing tham khảo trả về chưa đầy đủ hoặc không nhất quán. Đọc lại danh sách trước khi chọn listing tham khảo kho.',
        PRODUCTION_PREPARATION_REFERENCE_INVALID:'Chưa đối chiếu được dữ liệu của đúng listing tham khảo. Đọc lại danh sách và chọn lại listing tham khảo kho.',
        PRODUCTION_PREPARATION_RESPONSE_INVALID:'Một phần dữ liệu ngành hoặc shop trả về chưa hợp lệ. Đọc lại thông tin; nếu vẫn lỗi, nhờ người phụ trách ứng dụng kiểm tra.',
        PRODUCTION_PREPARATION_CACHE_TTL_INVALID:'Thiết lập thời gian lưu kết quả đọc chưa hợp lệ. Nhờ người phụ trách ứng dụng kiểm tra cấu hình trước khi đọc lại thông tin ngành.',
        PRODUCTION_PREPARATION_AUTOFILL_TIMEOUT:'Tra cứu quá 6 phút nên đã dừng. Các lựa chọn vẫn được giữ; kiểm tra kết nối shop rồi thử lại. Chưa gửi listing.',
        PRODUCTION_BATCH_REVIEW_READBACK_EXPIRED:'Kết quả đọc đã cũ. Bấm đọc lại kết quả rồi mở lại phần đối chiếu.',
        PRODUCTION_BATCH_REVIEW_READS_EXPIRED:'Kết quả đọc đã cũ. Bấm đọc lại kết quả rồi mở lại phần đối chiếu.',
      };
      return reply.status(code.endsWith('_NOT_FOUND')?404:409).send({code,message:messages[code]??'Thông tin chưa đủ điều kiện hoặc đã thay đổi. Mở kết quả để xem phần cần xử lý; chưa gửi thêm thay đổi.'});
    }
    if (/^(PRODUCTION_BATCH|PASS1)_[A-Z0-9_]+$/.test(code)) return reply.status(code.endsWith('NOT_REGISTERED')?404:409).send({code,message:
      code.endsWith('IN_PROGRESS')?'Đợt đang xử lý hoặc chưa ghi xong kết quả. Đọc lại trạng thái trước khi tiếp tục.':
      code.endsWith('STATUS_CHANGED')?'Trạng thái đã thay đổi. Đọc lại đợt đăng để tiếp tục đúng phần còn lại.':
      code.endsWith('EXECUTION_DISABLED')?'Luồng đăng shop thật chưa được bật.':'Bộ nguồn hoặc kết quả đã lưu cần được kiểm tra trước khi tiếp tục.'});
    if (/^PRODUCTION_EXECUTION_POLICY_[A-Z0-9_]+$/.test(code))
      return reply.status(409).send({code,message:code.endsWith('IN_PROGRESS')
        ? 'Đợt đăng đang xử lý. Chờ kết quả rồi đọc lại trước khi thay đổi chế độ thực hiện.'
        : 'Chế độ thực hiện không còn khớp nguồn hoặc trạng thái đợt đăng. Đọc lại kết quả để đối chiếu; chưa gửi thêm thay đổi.'});
    if (/^PRODUCTION_PILOT_[A-Z0-9_]+$/.test(code)) return reply.status(409).send({code,message:
      code==='PRODUCTION_PILOT_DISABLED'?'Luồng đăng shop thật chưa được bật.':
      code==='PRODUCTION_PILOT_RECONCILIATION_REQUIRED'?'Lô này đã có lần gửi. Xem kết quả và đối chiếu trước khi lập phiên bản tiếp theo.':
      'Lô đăng chưa đủ điều kiện hoặc có kết quả cần đối chiếu. Dữ liệu và lịch sử gửi được giữ lại.'});
    if (/^PRODUCTION_AUTHORIZATION_[A-Z_]+$/.test(code))
      return reply.status(409).send({ code, message: 'Phiên cấp quyền chưa hợp lệ, đang xử lý hoặc đã hết hạn. Tải lại kết nối để kiểm tra.' });
    if (/^PRODUCTION_CONNECTION_[A-Z_]+$/.test(code))
      return reply.status(409).send({ code, message: 'Chưa xác minh được kết nối production. Kiểm tra đúng khóa, token và phiên kết nối.' });
    if (/^IMAGE_QC_[A-Z_]+$/.test(code))
      return reply.status(code === 'IMAGE_QC_NOT_FOUND' ? 404 : 409).send({
        code,
        message:
          'Phiếu kiểm ảnh đã đổi, hết hạn hoặc chưa đủ điều kiện. Tải lại phiếu và đối chiếu đúng cặp ảnh trước khi lưu nhận xét.',
      });
    if (code.startsWith('PREPARED_'))
      return reply.status(code === 'PREPARED_NOT_FOUND' ? 404 : 409).send({
        code: code.split(':')[0],
        message:
          'Bộ đăng chưa đủ điều kiện hoặc nguồn đã đổi. Giữ kết quả hiện tại để đối chiếu; chưa gửi thêm thay đổi.',
      });
    if (code === 'CONNECTION_NAME_REVISION_CONFLICT' || code === 'CONNECTION_NAME_NOT_FOUND')
      return reply.status(code === 'CONNECTION_NAME_NOT_FOUND' ? 404 : 409).send({
        code,
        message:
          code === 'CONNECTION_NAME_NOT_FOUND'
            ? 'Không tìm thấy kết nối shop này.'
            : 'Tên gợi nhớ đã có bản mới. Tải lại danh sách shop để đối chiếu trước khi lưu.',
      });
    if (/^FIELD_/.test(code)) {
      const safeCode = code.split(':')[0]!;
      return reply.status(safeCode === 'FIELD_NOT_FOUND' ? 404 : 409).send({
        code: safeCode,
        message:
          'Phép thử chưa đủ điều kiện hoặc dữ liệu đã thay đổi. Giữ kết quả để đối chiếu; không tự gửi lại.',
      });
    }
    if (/^PATCH_/.test(code)) {
      const messages: Record<string, string> = {
        PATCH_TARGET_CHANGED:
          'Công việc hoặc shop đã đổi phiên bản. Mở lại bản mới nhất và đối chiếu bộ cập nhật.',
        PATCH_SOURCE_CHANGED: 'Bộ nguồn đã có phiên bản mới. Chọn đúng bản nguồn trước khi lưu.',
        PATCH_TARGET_REQUIRED: 'Chọn công việc cập nhật đã xác định shop và mã listing đích.',
        PATCH_SOURCE_KIND:
          'Loại tệp không khớp trường đã chọn. Chọn lại Word, ảnh hoặc Excel đúng vai trò.',
        PATCH_SOURCE_NOT_READY: 'Tệp nguồn chưa đọc xong. Chờ xử lý hoặc kiểm tra lỗi tệp.',
        PATCH_PREVIEW_CHANGED:
          'Dữ liệu đã thay đổi sau khi xem trước. Đối chiếu lại trước khi lưu.',
        PATCH_SAVE_CONFLICT:
          'Yêu cầu lưu này đã dùng cho nội dung khác. Giữ bản đã lưu và mở lại bộ cập nhật.',
        PATCH_SELECTION_BLOCKED:
          'Chọn ít nhất một thay đổi hợp lệ; bỏ chọn các phần còn lỗi hoặc không thay đổi.',
        PATCH_SOURCE_OUTSIDE_MANIFEST: 'Tệp đã chọn không nằm trong bộ cập nhật đang nhập.',
        PATCH_SOURCE_INTEGRITY: 'Tệp gốc không còn khớp bản đã nhập. Nhập lại đúng tệp nguồn.',
        PATCH_MANIFEST_INVALID: 'Danh sách tệp hoặc đường dẫn bị trùng; kiểm tra lại bộ cập nhật.',
        PATCH_NOT_FOUND: 'Không tìm thấy bộ cập nhật đã lưu.',
      };
      return reply
        .status(
          code === 'PATCH_NOT_FOUND' ? 404 : /CHANGED|CONFLICT|BLOCKED/.test(code) ? 409 : 400,
        )
        .send({
          code,
          message:
            messages[code] ??
            'Bộ cập nhật chưa khớp nguồn hoặc đích đã chọn. Kiểm tra các tệp và lựa chọn để tiếp tục.',
        });
    }
    const inputMessages: Record<string, string> = {
      INPUT_BATCH_PENDING_SOURCE_CHANGED:
        'Hồ sơ phân loại gốc đã khác bản đang bổ sung. Giữ nguyên nhãn và thứ tự; mở đúng bộ nguồn để tiếp tục.',
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
    if (code.startsWith('FOLDER_SOURCE_'))
      return reply.status(/CHANGED|CONFLICT|STALE/.test(code) ? 409 : 400).send({ code,
        message: code === 'FOLDER_SOURCE_CHANGED'
          ? 'Bộ listing này đã có bản nháp nhưng nội dung, phân loại hoặc bộ giá đã khác. Mở bản đã lưu để đối chiếu; chưa tạo bản trùng.'
          : code === 'FOLDER_SOURCE_BINDING_STALE'
            ? 'Bộ đầu vào đã có phiên bản mới. Mở lại bản đã lưu trước khi tiếp tục.'
            : 'Chưa đối chiếu được đúng hồ sơ nguồn với bản nháp. Giữ nguyên tệp và mở lại bộ đầu vào; chưa tạo bản mới.' });
    if (code.startsWith('PENDING_SOURCE_'))
      return reply.status(code.endsWith('_STALE') ? 409 : 400).send({ code,
        message: code === 'PENDING_SOURCE_INCOMPLETE'
          ? 'Bảng phân loại còn SKU hoặc giá chưa khớp. Điền đủ từng ô và xác nhận dùng đủ phân loại trước khi tạo bản nháp.'
          : 'Bản nháp chưa khớp bảng phân loại và tệp nguồn đã lưu. Mở lại đúng bộ đầu vào để đối chiếu; chưa tạo listing mới.' });
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
    if (/^WORK_ORDER_/.test(code))
      return reply.status(code === 'WORK_ORDER_NOT_FOUND' ? 404 : 409).send({
        code,
        message:
          'Công việc chưa lưu được. Đối chiếu bản đã lưu, nguồn và shop đích trước khi thử lại.',
      });
    if (/^HANDOFF_/.test(code))
      return reply.status(409).send({
        code,
        message:
          'Hồ sơ bàn giao chưa khớp nguồn hoặc bản đã lưu. Giữ tài liệu và đối chiếu lại trước khi áp dụng.',
      });
    if (/^SANDBOX_API_REJECTED:/.test(code)) {
      const auth = /access|acceess|auth|token/i.test(code);
      return reply.status(409).send({
        code: auth ? 'SANDBOX_AUTH_REQUIRED' : 'SANDBOX_API_REJECTED',
        message: auth
          ? 'Shopee không chấp nhận token TEST đã lưu. Mở Kết nối shop và cập nhật token hợp lệ.'
          : 'Shopee từ chối yêu cầu. Giữ bộ nguồn và kiểm tra điều kiện của shop.',
      });
    }
    if (/^SANDBOX_/.test(code))
      return reply
        .status(code === 'SANDBOX_RUN_NOT_FOUND' ? 404 : 409)
        .send({ code, message: 'Lần kiểm tra sandbox cần được đối chiếu lại trước khi tiếp tục.' });
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
    @Inject(WorkbenchService) readonly workbench: WorkbenchService,
    @Inject(HandoffService) readonly handoffs: HandoffService,
    @Inject(SandboxListingService) readonly sandbox: SandboxListingService,
    @Inject(SandboxTrialService) readonly trials: SandboxTrialService,
    @Inject(ImportPatchService) readonly patches: ImportPatchService,
    @Inject(SandboxFieldTrialService) readonly fieldTrials: SandboxFieldTrialService,
    @Inject(PreparedBatchService) readonly preparedBatches: PreparedBatchService,
    @Inject(ImageQcService) readonly imageQc: ImageQcService,
    @Inject(ProductionPilotService) readonly productionPilot: ProductionPilotService,
    @Inject(ProductionBatchService) readonly productionBatch: ProductionBatchService,
    @Inject(ProductionBatchReviewService) readonly productionBatchReview: ProductionBatchReviewService,
    @Inject(ProductionPreparationService) readonly productionPreparation: ProductionPreparationService,
    @Inject(ProductionPreparationExecution) readonly productionPreparationExecution: ProductionPreparationExecution,
    @Inject(ProductionPreparationMetadataService) readonly productionPreparationMetadata: ProductionPreparationMetadataService,
    @Inject(ProductionPreparationAutofillService) readonly productionPreparationAutofill: ProductionPreparationAutofillService,
  ) {}
  @Get('production-batches') productionBatchList(@Query() query:unknown) { productionRouteScope(query);return this.productionBatch.list(); }
  @Post('production-batches/:id/exclusions') productionBatchExclude(@Param('id') key:string,@Query() query:unknown, @Body() raw:unknown) { productionRouteScope(query);return this.productionBatch.exclude(key, raw); }
  @Get('production-batches/:id/review') productionBatchReviewStatus(@Param('id') key:string,@Query() query:any) { productionRouteScope(query);return this.productionBatchReview.review(key,String(query.sourceKey ?? '')); }
  @Post('production-batches/:id/review/approve') productionBatchReviewApprove(@Param('id') key:string,@Query() query:unknown,@Body() raw:unknown) { productionRouteScope(query);return this.productionBatchReview.approve(key,raw); }
  @Get('production-preparations/context') productionPreparationContext(@Query() query:unknown) { productionRouteScope(query);return this.productionPreparation.context(); }
  @Post('production-preparations/autofill') async productionPreparationFill(@Query() query:unknown,@Body() raw:unknown, @Req() req:any, @Res({ passthrough: true }) reply:any) {
    productionRouteScope(query);
    // Read-only preparation: stop upstream reads when the operator leaves/cancels.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    const deadline = setTimeout(() => controller.abort(new Error('PRODUCTION_PREPARATION_AUTOFILL_TIMEOUT')), 360_000);
    try { return await this.productionPreparationAutofill.recommend(raw, controller.signal); }
    finally {
      clearTimeout(deadline);
      req.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', cancel);
    }
  }
  @Get('production-preparations/metadata') productionPreparationOptions(@Query() raw:Record<string,unknown>) {
    const query={...raw};
    productionRouteScope(query);delete query.partnerId;delete query.shopId;
    for(const key of ['brandOffset','inventoryOffset']) if(typeof query[key]==='string' && /^\d+$/.test(query[key] as string)) query[key]=Number(query[key]);
    if(query.includeInventory==='true') query.includeInventory=true;
    if(query.includeInventory==='false') query.includeInventory=false;
    return this.productionPreparationMetadata.get(productionPreparationMetadataQuerySchema.parse(query));
  }
  @Get('production-preparations/:id') productionPreparationGet(@Param('id') key:string,@Query() query:unknown) { productionRouteScope(query);return this.productionPreparation.get(key); }
  @Get('production-preparations/:id/execution') productionPreparationExecutionGet(@Param('id') key:string,@Query() query:unknown) { productionRouteScope(query);return this.productionPreparationExecution.get(key); }
  @Post('production-preparations/:id/run') productionPreparationExecutionRun(@Param('id') key:string,@Query() query:unknown,@Body() raw:unknown) { productionRouteScope(query);return this.productionPreparationExecution.start(key,raw); }
  @Post('production-preparations/preview') productionPreparationPreview(@Query() query:unknown,@Body() raw:unknown) { productionRouteScope(query);return this.productionPreparation.preview(raw); }
  @Post('production-preparations/:id/register') productionPreparationRegister(@Param('id') key:string,@Query() query:unknown,@Body() raw:unknown) { productionRouteScope(query);return this.productionPreparation.register(key,raw); }
  @Get('production-batches/:id') productionBatchStatus(@Param('id') key:string,@Query() query:unknown) { productionRouteScope(query);return this.productionBatch.status(key); }
  @Post('production-batches/:id/publish') async productionBatchPublish(@Param('id') key:string,@Query() query:unknown,@Body() raw:unknown,@Res() reply:any) {
    productionRouteScope(query);
    return reply.status(202).send(await this.productionBatch.publish(key,raw));
  }
  @Post('production-batches/:id/run') async productionBatchRun(@Param('id') key:string,@Query() query:unknown,@Body() raw:unknown,@Res() reply:any) {
    productionRouteScope(query);
    return reply.status(202).send(await this.productionBatch.start(key,raw));
  }
  @Get('production-pilot/status') productionPilotStatus() { return this.productionPilot.status(); }
  @Post('production-pilot/start') async productionPilotStart(@Body() raw: unknown,@Res() reply:any) {
    return reply.status(202).send(await this.productionPilot.start(raw));
  }
  @Get('production-pilot/assets/:id') async productionPilotAsset(@Param('id') key:string,@Res() reply:any) {
    const asset=await this.productionPilot.asset(key);
    return reply.header('Cache-Control','private, no-store').type(asset.mime).send(asset.bytes);
  }
  @Get('source-catalogs') sourceCatalogs() {
    return listSourceCatalogs(this.repo.pool);
  }
  @Get('source-catalogs/:id') async sourceCatalog(@Param('id') key: string) {
    const result = await getSourceCatalog(this.repo.pool, id(key));
    if (!result) throw new HttpException({ message: 'Không tìm thấy bộ dữ liệu đã nhận.' }, 404);
    return result;
  }
  @Get('source-catalogs/:id/evidence') async sourceCatalogEvidence(@Param('id') key: string) {
    if (!(await getSourceCatalog(this.repo.pool, id(key))))
      throw new HttpException({ message: 'Không tìm thấy bộ dữ liệu đã nhận.' }, 404);
    return listSourceCatalogEvidence(this.repo.pool, key);
  }
  @Get('source-catalogs/:id/listings') async sourceCatalogRows(
    @Param('id') key: string,
    @Query() raw: unknown,
  ) {
    const input = z
      .object({
        brand: z.string().max(150).optional(),
        q: z.string().max(250).optional(),
        issue: z
          .enum(['all', 'no_design', 'multiple_designs', 'missing_item_id', 'existing_item_id', 'source_review'])
          .default('all'),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
        lifecycle: z.enum(['active','archived','all']).default('active'),
      })
      .parse(raw);
    if (!(await getSourceCatalog(this.repo.pool, id(key))))
      throw new HttpException({ message: 'Không tìm thấy bộ dữ liệu đã nhận.' }, 404);
    return queryCatalogListings(this.repo.pool, key, input);
  }
  @Get('source-catalogs/:id/listings/:listingId') async sourceCatalogRow(
    @Param('id') key: string,
    @Param('listingId') listingKey: string,
  ) {
    z.string().min(1).max(150).parse(listingKey);
    const result = await getCatalogListing(this.repo.pool, id(key), listingKey);
    if (!result)
      throw new HttpException(
        { message: 'Không tìm thấy dòng nội dung trong bộ dữ liệu này.' },
        404,
      );
    return {...result,...await localArchiveFlags(this.repo.pool,'catalog_listing',`${key}/${listingKey}`)};
  }
  @Get('image-qc') listImageQc() {
    return this.imageQc.list();
  }
  @Get('image-qc/:id') getImageQc(@Param('id') key: string) {
    return this.imageQc.get(id(key));
  }
  @Post('image-qc/:id/review') reviewImageQc(@Param('id') key: string, @Body() raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'id' in raw)
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.imageQc.review({ ...raw, id: id(key) } as Parameters<ImageQcService['review']>[0]);
  }
  @Get('image-qc/:id/image/:side') async imageQcBytes(
    @Param('id') key: string,
    @Param('side') side: string,
    @Res() reply: any,
  ) {
    const which = z.enum(['source', 'output']).parse(side),
      review = await this.imageQc.get(id(key));
    const bytes = await this.blobs.read(
      which === 'source' ? review.sourceSha256 : review.outputSha256,
    );
    const format = review.comparison.evidence?.[which]?.format;
    if (!['png', 'jpeg', 'webp'].includes(format ?? ''))
      throw new HttpException({ code: 'IMAGE_QC_IMAGE_UNAVAILABLE' }, 409);
    return reply
      .header('Cache-Control', 'private, no-store')
      .type('image/' + format)
      .send(bytes);
  }
  @Get('prepared-batches/context') preparedContext() {
    return this.preparedBatches.context();
  }
  @Get('prepared-batches/template') async preparedTemplate(@Res() reply: any) {
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', 'attachment; filename="mau-dieu-phoi-listing.xlsx"')
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(await createPreparedDispatchTemplate());
  }
  @Post('prepared-batches/preview') preparedPreview(@Body() raw: unknown) {
    return this.preparedBatches.preview(raw);
  }
  @Get('prepared-batches/:id') preparedBatch(@Param('id') key: string) {
    return this.preparedBatches.get(id(key));
  }
  @Post('prepared-batches/:id/submit') submitPreparedBatch(
    @Param('id') key: string,
    @Body() raw: unknown,
  ) {
    return this.preparedBatches.submit(id(key), raw);
  }
  @Post('prepared-jobs/:id/control') controlPreparedJob(
    @Param('id') key: string,
    @Body() raw: unknown,
  ) {
    const { action } = z
      .object({ action: z.enum(['pause', 'resume', 'cancel']) })
      .strict()
      .parse(raw);
    return this.preparedBatches.control(id(key), action);
  }
  @Post('prepared-jobs/:id/reconcile') reconcilePreparedJob(@Param('id') key: string) {
    return this.preparedBatches.reconcile(id(key));
  }
  @Get('sandbox-tryout/context') sandboxTryoutContext() {
    return sandboxTryoutContext(this.repo);
  }
  @Post('sandbox-field-trials/inspect') inspectFieldTrial(@Body() raw: unknown) {
    return this.fieldTrials.inspect(raw);
  }
  @Post('sandbox-field-trials/prepare') prepareFieldTrial(@Body() raw: unknown) {
    return this.fieldTrials.prepare(raw);
  }
  @Post('sandbox-field-trials/execute') executeFieldTrial(@Body() raw: unknown) {
    return this.fieldTrials.execute(raw);
  }
  @Post('sandbox-field-trials/:id/cancel') cancelFieldTrial(
    @Param('id') key: string,
    @Body() raw: unknown,
  ) {
    const input = z
      .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(raw);
    return this.fieldTrials.cancel({ id: id(key), ...input });
  }
  @Get('sandbox-field-trials/:id') getFieldTrial(@Param('id') key: string) {
    return this.fieldTrials.get(id(key));
  }
  @Get('import-patches/context') patchContext() {
    return this.patches.context();
  }
  @Get('import-patches/workbooks/:id') patchWorkbook(@Param('id') key: string) {
    return this.patches.workbook(id(key));
  }
  @Post('import-patches/preview') patchPreview(@Body() raw: unknown) {
    return this.patches.preview(raw);
  }
  @Post('import-patches') savePatch(@Body() raw: unknown) {
    return this.patches.save(raw);
  }
  @Get('import-patches') listPatches() {
    return this.patches.list();
  }
  @Get('import-patches/:id') getPatch(@Param('id') key: string) {
    return this.patches.get(id(key));
  }
  @Post('sandbox-create-trials/inspect') inspectTrial(@Body() raw: unknown) {
    return this.trials.inspect(raw);
  }
  @Post('sandbox-create-trials/prepare') prepareTrial(@Body() raw: unknown) {
    return this.trials.prepare(raw);
  }
  @Get('sandbox-create-trials/preparations/:id') getTrialPreparation(@Param('id') key: string) {
    return this.trials.get(key);
  }
  @Post('sandbox-create-trials/preparations/:id/submit') submitTrial(
    @Param('id') key: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) reply: any,
  ) {
    reply.status(202);
    return this.trials.submit(key, raw);
  }
  @Get('sandbox-create-trials') listTrials() {
    return this.trials.list();
  }
  @Get('sandbox-create-trials/:id') getTrial(@Param('id') key: string) {
    return this.trials.getTrial(key);
  }
  @Get('handoffs/products/:key') exportHandoff(@Param('key') key: string) {
    return this.handoffs.exportProduct(key);
  }
  @Post('handoffs/preview') previewHandoff(@Body() raw: unknown) {
    return this.handoffs.preview(raw);
  }
  @Post('handoffs/apply') applyHandoff(@Body() raw: unknown) {
    return this.handoffs.apply(raw);
  }
  @Post('sandbox-listings/read') readSandbox(@Body() raw: unknown) {
    return this.sandbox.read(raw);
  }
  @Post('sandbox-listings/prepare') prepareSandbox(@Body() raw: unknown) {
    return this.sandbox.prepare(raw);
  }
  @Get('sandbox-listings/runs/:id') getSandboxRun(@Param('id') key: string) {
    return this.sandbox.get(id(key));
  }
  @Post('sandbox-listings/runs/:id/execute') executeSandbox(
    @Param('id') key: string,
    @Body() raw: unknown,
  ) {
    const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(raw);
    return this.sandbox.execute({ id: id(key), ...input });
  }
  @Post('sandbox-listings/runs/:id/reconcile') reconcileSandbox(
    @Param('id') key: string,
    @Body() raw: unknown,
  ) {
    const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(raw);
    return this.sandbox.reconcile({ id: id(key), ...input });
  }
  @Get('workbench') getWorkbench() {
    return this.workbench.list();
  }
  @Get('work-orders/:id') workOrder(@Param('id') key: string) {
    return this.workbench.get(id(key));
  }
  @Post('work-orders') saveWorkOrder(@Body() raw: unknown) {
    return this.workbench.save(raw);
  }
  @Get('local-archives') localArchives(@Query('lifecycle') raw?: string) {
    return listLocalArchives(this.repo.pool, lifecycle(raw ?? 'archived'));
  }
  @Post('local-archives') setLocalArchive(@Body() raw: unknown) {
    const input = z.object({kind:z.enum(localArchiveKinds),resourceId:z.string().min(1).max(400),archived:z.boolean()}).strict().parse(raw);
    return setLocalArchive(this.repo.pool,input,input.archived);
  }
  @Get('input-library') inputLibrary(@Query('lifecycle') raw?: string) {
    return this.input.library.library(lifecycle(raw));
  }
  @Get('input-batches') inputBatches(@Query('lifecycle') raw?: string) {
    return this.input.library.list(lifecycle(raw));
  }
  @Get('input-batches/:id') async inputBatch(@Param('id') key: string) {
    const record = await this.input.library.get(id(key));
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return {...record,...await localArchiveFlags(this.repo.pool,'input_batch',key)};
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
      statusScope: 'legacy_worker',
      workspaceResetId: (await workspaceResetState())?.id,
      productionBatchWorkflow: {
        enabled: process.env.PRODUCTION_PILOT_ENABLED === '1',
        statusPath: '/v1/production-batches',
        requiresPerBatchChecks: true,
      },
      sandboxTrialExecutor: 'bounded_synthetic_unlisted',
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
    return {...record,...await localArchiveFlags(this.repo.pool,'pricebook',record.id)};
  }
  @Get('imports') imports(@Query('lifecycle') raw?: string) {
    return this.repo.listImports(lifecycle(raw));
  }
  @Get('imports/:id') async imported(@Param('id') key: string) {
    const record = await this.repo.getImport(id(key));
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return {...record,...await localArchiveFlags(this.repo.pool,'pricebook',key)};
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
  @Get('products') async products(@Query('lifecycle') raw?: string) {
    return projectProductPriceIssues(this.repo, await this.repo.listProducts(lifecycle(raw)));
  }
  @Get('products/:key') async product(@Param('key') key: string) {
    const record = await this.repo.getProduct(key);
    if (!record) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return {...(await projectProductPriceIssues(this.repo, [record]))[0]!,...await localArchiveFlags(this.repo.pool,'product',key)};
  }
  @Post('products') async saveProduct(@Body() raw: unknown) {
    const input = productInput.parse(raw);
    return saveAssembledProduct(this.repo, input);
  }
  @Get('shops') async shops() {
    return listShopConnections(this.repo.pool);
  }
  @Patch('connections/:id/display-name') connectionDisplayName(
    @Param('id') key: string,
    @Body() raw: unknown,
  ) {
    return setConnectionDisplayName(this.repo.pool, id(key), raw);
  }
  @Get('plans') plans() {
    return this.repo.listPlans();
  }
  @Post('connections/sandbox') connect(@Body() raw: unknown) {
    return connectSandbox(this.repo, raw);
  }
  @Get('connections/production') productionShopTarget(@Query() query:unknown) {return productionConnectionTarget(this.repo,query);}
  @Post('connections/production') connectProductionShop(@Body() raw:unknown) {return connectProductionPilot(this.repo,raw,{allowOtherShops:true});}
  @Post('connections/production/authorize') async authorizeProductionShop(@Body() raw:unknown,@Res({passthrough:true}) reply:any) {
    const {browserSecret,...result}=await prepareProductionAuthorization(this.repo,raw,{allowOtherShops:true});
    reply.header('Set-Cookie',`${productionAuthorizationCookie}=${browserSecret}; Path=/v1/connections/production-pilot; HttpOnly; SameSite=Lax; Max-Age=1200`);
    return result;
  }
  @Post('connections/:id/refresh') refreshConnection(@Param('id') key:string,@Body() raw:unknown) {
    const input=z.object({expectedRevision:z.number().int().positive()}).strict().parse(raw);
    return new ConnectionMaintenance(this.repo).refresh(id(key),input.expectedRevision);
  }
  @Post('connections/:id/check') checkConnection(@Param('id') key:string,@Body() raw:unknown) {
    const input=z.object({expectedRevision:z.number().int().positive()}).strict().parse(raw);
    return new ConnectionMaintenance(this.repo).check(id(key),input.expectedRevision);
  }
  @Post('connections/:id/auto-refresh') async autoRefreshConnection(@Param('id') key:string,@Body() raw:unknown) {
    const input=z.object({enabled:z.boolean(),expectedRevision:z.number().int().positive()}).strict().parse(raw);
    const result=await this.repo.pool.query("UPDATE connections SET auto_refresh=$3 WHERE id=$1 AND revision=$2 AND environment='production' RETURNING id",[id(key),input.expectedRevision,input.enabled]);
    if(!result.rowCount)throw Error('PRODUCTION_CONNECTION_REVISION_CONFLICT');
    return {enabled:input.enabled};
  }
  @Get('connections/production-pilot') productionTarget() {
    return productionConnectionTarget(this.repo);
  }
  @Post('connections/production-pilot') connectProduction(@Body() raw: unknown) {
    return connectProductionPilot(this.repo, raw);
  }
  @Post('connections/production-pilot/authorize') async authorizeProduction(
    @Body() raw: unknown, @Res({ passthrough: true }) reply: any,
  ) {
    const { browserSecret, ...result } = await prepareProductionAuthorization(this.repo, raw);
    reply.header('Set-Cookie', `${productionAuthorizationCookie}=${browserSecret}; Path=/v1/connections/production-pilot; HttpOnly; SameSite=Lax; Max-Age=1200`);
    return result;
  }
  @Get('connections/production-pilot/authorization/:attemptId') authorizationStatus(
    @Param('attemptId') attemptId: string, @Req() req: any,
  ) {
    return productionAuthorizationStatus(this.repo, attemptId, authorizationBrowserSecret(req));
  }
  @Post('connections/production-pilot/authorization/:attemptId/cancel') cancelAuthorization(@Param('attemptId') attemptId:string,@Req() req:any) {
    return cancelProductionAuthorization(this.repo,attemptId,authorizationBrowserSecret(req));
  }
  @Get('connections/production-pilot/callback') async productionCallback(
    @Query() raw: unknown, @Req() req: any, @Res() reply: any,
  ) {
    try {
      const result = await finishProductionAuthorization(this.repo, raw, authorizationBrowserSecret(req));
      return reply.status(303).header('Location', '/v1/connections/production-pilot/authorization-result/' + result.attemptId).send('');
    } catch { return authorizationPage(reply, 'invalid', 400); }
  }
  @Get('connections/production-pilot/authorization-result/:attemptId') async productionAuthorizationResult(
    @Param('attemptId') attemptId: string, @Req() req: any, @Res() reply: any,
  ) {
    try {
      const result = await productionAuthorizationStatus(this.repo, attemptId, authorizationBrowserSecret(req));
      return authorizationPage(reply, result.status);
    } catch { return authorizationPage(reply, 'invalid', 400); }
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
      block('PRODUCTION_READ_ONLY', 'Bản kế hoạch nội bộ này không gửi lên shop thật. Thực hiện qua mục Đăng hàng và đợt API tương ứng.');
    block(
      'EXECUTOR_NOT_RELEASED',
      'Đây là bản kiểm tra được lưu riêng; không có bộ thực thi cho bản kế hoạch này.',
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
  options: {
    knowledge?: KnowledgePort;
    trialTransport?: typeof fetch;
    trialEncryptionKey?: string;
    trialPause?: () => Promise<void>;
    preparedGateway?: PreparedGateway;
    sellerKnowledge?: SellerKnowledgeService;
  } = {},
): Promise<NestFastifyApplication> {
  @Module({
    controllers: [AppController, HealthController, SellerKnowledgeController, SellerKnowledgeDraftController],
    providers: [
      { provide: REPO, useValue: repo },
      { provide: BLOBS, useValue: blobs },
      { provide: SellerKnowledgeService, useValue: options.sellerKnowledge ?? new SellerKnowledgeService(repo) },
      { provide: SellerKnowledgeFacts, useValue: new SellerKnowledgeFacts(repo) },
      { provide: SellerKnowledgeDraftService, inject:[SellerKnowledgeService,SellerKnowledgeFacts], useFactory:(knowledge:SellerKnowledgeService,facts:SellerKnowledgeFacts)=>new SellerKnowledgeDraftService(repo,knowledge,facts) },
      { provide: ProductionBatchService, useValue: new ProductionBatchService(repo, blobs) },
      { provide: ProductionBatchReviewService, useValue: new ProductionBatchReviewService(repo, blobs) },
      { provide: ProductionPreparationService, useValue: new ProductionPreparationService(repo, blobs) },
      { provide: ProductionPreparationAutofillService, useValue: new ProductionPreparationAutofillService(repo) },
      { provide: ProductionPreparationMetadataService, useValue: new ProductionPreparationMetadataService(repo) },
      { provide: ProductionPreparationExecution, inject:[ProductionPreparationService,ProductionBatchService], useFactory:(prepared:ProductionPreparationService,batches:ProductionBatchService)=>new ProductionPreparationExecution(repo,prepared,batches) },
      { provide: ProductionPilotService, useValue: new ProductionPilotService(repo, {
        coverImageQc: productionPilotImageService(repo, blobs, resolve(productionPilotSourceRoot, 'assets')),
        weightReview: { findReview: productionPilotWeightReviewFileLookup(productionPilotSourceRoot) },
      }) },
      { provide: InputService, useValue: new InputService(repo) },
      { provide: WorkbenchService, useValue: new WorkbenchService(repo) },
      { provide: ImportPatchService, useValue: new ImportPatchService(repo, blobs) },
      {
        provide: PreparedBatchService,
        useValue: new PreparedBatchService(repo, blobs, options.preparedGateway),
      },
      { provide: ImageQcService, useValue: new ImageQcService(repo, blobs) },
      { provide: HandoffService, useValue: new HandoffService(repo) },
      { provide: SandboxListingService, useValue: new SandboxListingService(repo, blobs) },
      {
        provide: SandboxFieldTrialService,
        useValue: new SandboxFieldTrialService(repo, {
          transport: options.trialTransport,
          encryptionKey: options.trialEncryptionKey,
          pause: options.trialPause,
        }),
      },
      {
        provide: SandboxTrialService,
        useValue: new SandboxTrialService(repo, blobs, {
          transport: options.trialTransport,
          encryptionKey: options.trialEncryptionKey,
          pause: options.trialPause,
        }),
      },
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
    if (req.url.startsWith('/v1/connections') || req.url.startsWith('/v1/shops')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
    }
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

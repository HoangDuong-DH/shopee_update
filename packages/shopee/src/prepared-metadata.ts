import type { PreparedDocument } from '@shopee/domain';
import { validateAttributeSelection } from './attribute-validation.js';

/** Pure compatibility assessment. It grants no write permission and does not construct defaults.
 * KB snapshot 2026-09-08: get_item_limit, get_brand_list, get_attribute_tree, add_item,
 * media_space.upload_image. Current capabilities must be supplied for the exact shop by the caller.
 */
export type PreparedSourceContext = {
  brandName?: string;
  condition?: string;
  preOrder?: { isPreOrder: boolean; daysToShip: number };
  gtinBySku?: Record<string, string>;
};
export type PreparedCapabilityEvidence = {
  state: 'allowed' | 'denied' | 'unknown';
  reference: string;
  observedAt: string;
};
export type PreparedMetadataIssue = { code: string; path: string; message: string };
export type PreparedMetadataRequirement = {
  field: string;
  reason: 'source_semantics' | 'api_required';
};
export type PreparedAttributeWire = {
  attribute_id: number;
  attribute_value_list: { value_id: number; original_value_name: string; value_unit?: string }[];
};
export type PreparedMetadataAssessment = {
  compatible: boolean;
  issues: PreparedMetadataIssue[];
  requirements: PreparedMetadataRequirement[];
  resolved: {
    brand?: { brand_id: number; original_brand_name: string };
    attributes: PreparedAttributeWire[];
    limits: Record<string, { min: number; max: number }>;
    gtinRule?: 'Mandatory' | 'Flexible' | 'Optional';
  };
};
export type PreparedMetadataInput = {
  document: PreparedDocument;
  source?: PreparedSourceContext;
  metadata: { itemLimit: unknown; brandPages: unknown[]; attributeTree: unknown };
  evidence?: {
    images34?: PreparedCapabilityEvidence;
    extendedDescription?: PreparedCapabilityEvidence;
  };
};
type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined;
const id = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
};
const size = (value: string) => Array.from(value).length;
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function assessPreparedMetadata(input: PreparedMetadataInput): PreparedMetadataAssessment {
  const { document, source, metadata } = input;
  const result: PreparedMetadataAssessment = {
    compatible: false,
    issues: [],
    requirements: [],
    resolved: { attributes: [], limits: {} },
  };
  const issue = (code: string, path: string, message: string) => {
    if (!result.issues.some((entry) => entry.code === code && entry.path === path))
      result.issues.push({ code, path, message });
  };
  const requireSource = (field: string, reason: PreparedMetadataRequirement['reason']) => {
    result.requirements.push({ field, reason });
    issue('SOURCE_REQUIRED', field, 'Cần giá trị có nguồn; hệ thống không tự đặt mặc định.');
  };
  const envelope = (raw: unknown, path: string) => {
    const root = object(raw);
    if (root && typeof root.error === 'string' && root.error) {
      issue('METADATA_API_ERROR', path, 'API metadata chưa trả kết quả thành công.');
      return undefined;
    }
    if (
      !root ||
      typeof root.error !== 'string' ||
      typeof root.request_id !== 'string' ||
      !root.request_id ||
      !object(root.response)
    ) {
      issue('METADATA_ENVELOPE_INVALID', path, 'Thiếu phản hồi API đầy đủ hoặc mã yêu cầu.');
      return undefined;
    }
    return object(root.response)!;
  };
  const range = (raw: unknown, key: string, integer = true) => {
    const value = object(raw);
    if (!value) {
      issue('METADATA_LIMIT_MISSING', key, 'Chưa có giới hạn trả về từ API.');
      return undefined;
    }
    const min = value.min_limit,
      max = value.max_limit;
    if (
      !number(min) ||
      !number(max) ||
      min < 0 ||
      max < min ||
      (integer && (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)))
    ) {
      issue('METADATA_LIMIT_INVALID', key, 'Giới hạn API không hợp lệ hoặc mâu thuẫn.');
      return undefined;
    }
    const parsed = { min, max };
    result.resolved.limits[key] = parsed;
    return parsed;
  };
  const within = (
    value: number,
    bounds: { min: number; max: number } | undefined,
    path: string,
  ) => {
    if (!Number.isFinite(value) || (bounds && (value < bounds.min || value > bounds.max)))
      issue('SOURCE_OUTSIDE_LIMIT', path, 'Giá trị nguồn nằm ngoài giới hạn API trả về.');
  };
  const capability = (value: PreparedCapabilityEvidence | undefined, key: string) => {
    if (value?.state === 'denied')
      issue(
        `CAPABILITY_${key}_DENIED`,
        key,
        'Shop chưa hỗ trợ vai trò ảnh này theo bằng chứng đã cung cấp.',
      );
    else if (
      value?.state !== 'allowed' ||
      !value.reference ||
      !Number.isFinite(Date.parse(value.observedAt))
    )
      issue(
        `CAPABILITY_${key}_UNKNOWN`,
        key,
        'Chưa có bằng chứng quyền sử dụng cho đúng shop; không tự đổi ảnh để bỏ qua.',
      );
  };

  if (!source?.condition) requireSource('condition', 'source_semantics');
  else if (!['NEW', 'USED'].includes(source.condition.toUpperCase()))
    issue(
      'SOURCE_CONDITION_INVALID',
      'condition',
      'Tình trạng nguồn chưa biểu đạt được bằng NEW hoặc USED.',
    );
  if (!source?.preOrder) requireSource('preOrder', 'source_semantics');
  else if (
    typeof source.preOrder.isPreOrder !== 'boolean' ||
    !Number.isSafeInteger(source.preOrder.daysToShip) ||
    source.preOrder.daysToShip < 0
  )
    issue(
      'SOURCE_PREORDER_INVALID',
      'preOrder',
      'Cần quyết định đặt trước và số ngày giao hàng có nguồn.',
    );

  const limit = envelope(metadata.itemLimit, 'itemLimit');
  if (limit) {
    within(
      size(document.title),
      range(limit.item_name_length_limit, 'item_name_length_limit'),
      'title',
    );
    within(
      document.gallery.length,
      range(limit.item_image_count_limit, 'item_image_count_limit'),
      'gallery',
    );
    const priceRange = range(limit.price_limit, 'price_limit', false);
    const stockRange = range(limit.stock_limit, 'stock_limit');
    document.models.forEach((model, index) => {
      if (!/^\d+(?:\.\d+)?$/.test(model.originalPrice))
        issue(
          'SOURCE_PRICE_INVALID',
          `models.${index}.originalPrice`,
          'Giá nguồn chưa phải số tiền rõ ràng.',
        );
      within(Number(model.originalPrice), priceRange, `models.${index}.originalPrice`);
      if (!Number.isSafeInteger(model.stock))
        issue(
          'SOURCE_STOCK_INVALID',
          `models.${index}.stock`,
          'Tồn đăng bán phải là số nguyên có nguồn.',
        );
      within(model.stock, stockRange, `models.${index}.stock`);
    });
    if (document.tierNames.length) {
      const names = range(
        limit.tier_variation_name_length_limit,
        'tier_variation_name_length_limit',
      );
      const options = range(
        limit.tier_variation_option_length_limit,
        'tier_variation_option_length_limit',
      );
      document.tierNames.forEach((name, index) => within(size(name), names, `tierNames.${index}`));
      document.models.forEach((model, index) =>
        model.optionLabels.forEach((label, option) =>
          within(size(label), options, `models.${index}.optionLabels.${option}`),
        ),
      );
    }
    const images = document.description.filter((block) => block.type === 'image');
    const textLength = document.description.reduce(
      (total, block) => total + (block.type === 'text' ? size(block.text) : 0),
      0,
    );
    if (!images.length)
      within(
        textLength,
        range(limit.item_description_length_limit, 'item_description_length_limit'),
        'description.text',
      );
    else {
      capability(input.evidence?.extendedDescription, 'EXTENDED_DESCRIPTION');
      const extended = object(limit.extended_description_limit);
      const pair = (min: string, max: string, integer = true) =>
        range(
          extended ? { min_limit: extended[min], max_limit: extended[max] } : undefined,
          `extended_description_limit.${min}`,
          integer,
        );
      within(
        textLength,
        pair('description_text_length_min', 'description_text_length_max'),
        'description.text',
      );
      within(
        images.length,
        pair('description_image_num_min', 'description_image_num_max'),
        'description.images',
      );
      const aspect = pair(
        'description_image_aspect_ratio_min',
        'description_image_aspect_ratio_max',
        false,
      );
      for (const [index, block] of images.entries()) {
        for (const dimension of ['width', 'height'] as const) {
          const minimum = extended?.[`description_image_${dimension}_min`];
          if (!number(minimum) || !Number.isSafeInteger(minimum) || minimum < 0)
            issue(
              'METADATA_LIMIT_MISSING',
              `extended_description_limit.description_image_${dimension}_min`,
              'Chưa có giới hạn kích thước ảnh mô tả hợp lệ.',
            );
          else if (block.image[dimension] < minimum)
            issue(
              'SOURCE_OUTSIDE_LIMIT',
              `description.images.${index}.${dimension}`,
              'Ảnh nguồn nhỏ hơn giới hạn API.',
            );
        }
        within(
          block.image.width / block.image.height,
          aspect,
          `description.images.${index}.aspectRatio`,
        );
      }
    }
    const dts = object(limit.dts_limit);
    if (source?.preOrder) {
      if (source.preOrder.isPreOrder)
        within(
          source.preOrder.daysToShip,
          range(dts?.days_to_ship_limit, 'dts_limit.days_to_ship_limit'),
          'preOrder.daysToShip',
        );
      else if (!Number.isSafeInteger(dts?.non_pre_order_days_to_ship))
        issue(
          'METADATA_LIMIT_MISSING',
          'dts_limit.non_pre_order_days_to_ship',
          'Chưa có số ngày giao hàng thường của ngành.',
        );
      else if (source.preOrder.daysToShip !== dts!.non_pre_order_days_to_ship)
        issue(
          'SOURCE_DTS_MISMATCH',
          'preOrder.daysToShip',
          'Số ngày nguồn khác số ngày giao hàng thường API trả về.',
        );
    }
    // The snapshot documents gtin_limit at the top level, unlike the other response fields.
    // Accept either observed envelope location, but reject conflicts instead of choosing one.
    const nestedRule = object(limit.gtin_limit)?.gtin_validation_rule;
    const rootRule = object(object(metadata.itemLimit)?.gtin_limit)?.gtin_validation_rule;
    if (nestedRule !== undefined && rootRule !== undefined && nestedRule !== rootRule)
      issue(
        'METADATA_GTIN_CONFLICT',
        'gtin_limit',
        'Hai vị trí phản hồi trả quy tắc GTIN khác nhau.',
      );
    else {
      const rule = nestedRule ?? rootRule;
      if (rule !== 'Mandatory' && rule !== 'Flexible' && rule !== 'Optional')
        issue('METADATA_GTIN_UNKNOWN', 'gtin_limit', 'Chưa xác định được quy tắc GTIN của ngành.');
      else {
        result.resolved.gtinRule = rule;
        for (const model of document.models) {
          const code = source?.gtinBySku?.[model.sku];
          if (code === undefined || code === '') {
            if (rule !== 'Optional') requireSource(`gtinBySku.${model.sku}`, 'api_required');
          } else if ((code === '00' && rule === 'Mandatory') || (code !== '00' && !validGtin(code)))
            issue(
              'SOURCE_GTIN_INVALID',
              `gtinBySku.${model.sku}`,
              'GTIN nguồn không phù hợp với quy tắc trả về; không tự thay bằng 00.',
            );
        }
      }
    }
    const sizeChartRequired = object(limit.size_chart_limit)?.size_chart_mandatory;
    if (typeof sizeChartRequired !== 'boolean')
      issue(
        'METADATA_SIZE_CHART_REQUIREMENT_UNKNOWN',
        'sizeChart',
        'API chưa trả tính bắt buộc của bảng kích thước; cờ hỗ trợ không thay thế quy tắc này.',
      );
    else if (sizeChartRequired)
      issue(
        'SOURCE_SIZE_CHART_UNREPRESENTED',
        'sizeChart',
        'Ngành yêu cầu bảng kích thước nhưng hợp đồng nguồn hiện chưa chứa trường này.',
      );
  }
  const ratios = document.gallery.map((image) => image.width / image.height);
  if (ratios.some((ratio) => Math.abs(ratio - 0.75) < 0.005))
    capability(input.evidence?.images34, 'IMAGES_34');
  if (
    ratios.some(
      (ratio) =>
        !Number.isFinite(ratio) ||
        (Math.abs(ratio - 1) >= 0.005 && Math.abs(ratio - 0.75) >= 0.005),
    ) ||
    (ratios.some((ratio) => Math.abs(ratio - 1) < 0.005) &&
      ratios.some((ratio) => Math.abs(ratio - 0.75) < 0.005))
  )
    issue(
      'SOURCE_GALLERY_RATIO_UNREPRESENTED',
      'gallery',
      'Bộ ảnh cần một tỷ lệ được hỗ trợ thống nhất; không tự cắt ảnh.',
    );
  if (document.cover.width !== document.cover.height)
    issue('SOURCE_COVER_RATIO_INVALID', 'cover', 'Ảnh bìa nguồn chưa phải 1:1.');
  if (
    ratios.length &&
    ratios.every((ratio) => Math.abs(ratio - 1) < 0.005) &&
    document.gallery[0]!.sha256 !== document.cover.sha256
  )
    issue(
      'SOURCE_SEPARATE_COVER_UNSUPPORTED',
      'cover',
      'Bìa riêng promotion_images chỉ biểu đạt cùng gallery 3:4; cần xử lý ngoại lệ nguồn.',
    );

  const brands: Raw[] = [];
  const pages = metadata.brandPages.map((raw, index) => envelope(raw, `brandPages.${index}`));
  if (
    !pages.length ||
    pages.some(
      (page, index) =>
        !page || !Array.isArray(page.brand_list) || page.has_next_page !== index < pages.length - 1,
    )
  )
    issue(
      'METADATA_BRAND_PAGES_INCOMPLETE',
      'brandPages',
      'Cần đủ các trang thương hiệu theo đúng ngành và trạng thái đã truy vấn.',
    );
  for (const page of pages)
    if (page && Array.isArray(page.brand_list)) {
      for (const candidate of page.brand_list) {
        const brand = object(candidate);
        if (
          !brand ||
          id(brand.brand_id) === undefined ||
          typeof brand.original_brand_name !== 'string' ||
          !brand.original_brand_name
        )
          issue(
            'METADATA_BRAND_INVALID',
            'brandPages',
            'Dữ liệu thương hiệu thiếu ID hoặc tên gốc.',
          );
        else brands.push(brand);
      }
    }
  const selectedBrands = brands.filter((brand) => String(brand.brand_id) === document.brandId);
  const brandNames = new Set(selectedBrands.map((brand) => brand.original_brand_name));
  if (!selectedBrands.length)
    issue(
      'SOURCE_BRAND_UNRESOLVED',
      'brandId',
      'Chưa ánh xạ được thương hiệu nguồn với ID API trả về.',
    );
  else if (brandNames.size !== 1)
    issue('METADATA_BRAND_AMBIGUOUS', 'brandId', 'Một ID thương hiệu có nhiều tên gốc mâu thuẫn.');
  else {
    const brand = selectedBrands[0]!;
    result.resolved.brand = {
      brand_id: brand.brand_id as number,
      original_brand_name: brand.original_brand_name as string,
    };
    if (source?.brandName !== undefined && source.brandName !== brand.original_brand_name)
      issue(
        'SOURCE_BRAND_NAME_MISMATCH',
        'brandName',
        'Tên thương hiệu nguồn không khớp tên gốc của ID đã chọn.',
      );
  }

  const tree = envelope(metadata.attributeTree, 'attributeTree');
  const categories = Array.isArray(tree?.list)
    ? tree.list
        .map(object)
        .filter((category) => category && String(category.category_id) === document.categoryId)
    : [];
  if (categories.length !== 1 || !Array.isArray(categories[0]?.attribute_tree))
    issue(
      'METADATA_CATEGORY_AMBIGUOUS',
      'attributeTree',
      'Cần đúng một cây thuộc tính của ngành nguồn.',
    );
  else {
    const visited = new Set<string>(),
      resolved = new Map<number, PreparedAttributeWire>(),
      active = new WeakSet<object>();
    let nodeCount = 0;
    const visit = (nodes: unknown[], depth = 0) => {
      if (depth > 30 || nodeCount > 10000) {
        issue(
          'METADATA_ATTRIBUTE_TREE_INVALID',
          'attributeTree',
          'Cây thuộc tính quá sâu hoặc quá lớn.',
        );
        return;
      }
      for (const raw of nodes) {
        nodeCount++;
        const node = object(raw),
          attributeId = id(node?.attribute_id),
          info = object(node?.attribute_info);
        if (
          !node ||
          attributeId === undefined ||
          typeof node.mandatory !== 'boolean' ||
          !Array.isArray(node.attribute_value_list) ||
          !info ||
          active.has(node)
        ) {
          issue(
            'METADATA_ATTRIBUTE_TREE_INVALID',
            'attributeTree',
            'Cấu trúc cây thuộc tính chưa đầy đủ hoặc lặp vòng.',
          );
          continue;
        }
        active.add(node);
        const key = String(attributeId),
          supplied = document.attributes[key] ?? [];
        visited.add(key);
        if (node.mandatory && !supplied.length)
          issue(
            'SOURCE_ATTRIBUTE_REQUIRED',
            `attributes.${key}`,
            'Thiếu thuộc tính bắt buộc của nhánh đang chọn.',
          );
        if (supplied.length) {
          const inputType = id(info.input_type);
          // SINGLE_* enum semantics establish one value even when the optional max is omitted.
          // Multi-select requires its actual returned limit; examples supply no fallback.
          const maximum =
            info.max_value_count === undefined && [1, 2, 3].includes(inputType ?? -1)
              ? 1
              : id(info.max_value_count);
          if (![1, 2, 3, 4, 5].includes(inputType ?? -1) || maximum === undefined || maximum < 1)
            issue(
              'METADATA_ATTRIBUTE_CONSTRAINT_UNKNOWN',
              `attributes.${key}`,
              'Thiếu kiểu nhập hoặc số giá trị cho phép.',
            );
          if (
            (maximum !== undefined && supplied.length > maximum) ||
            ([1, 2, 3].includes(inputType ?? -1) && supplied.length > 1)
          )
            issue(
              'SOURCE_ATTRIBUTE_COUNT_INVALID',
              `attributes.${key}`,
              'Số giá trị nguồn vượt quy tắc của thuộc tính.',
            );
          const values = node.attribute_value_list.map(object);
          const wire: PreparedAttributeWire = {
            attribute_id: attributeId,
            attribute_value_list: [],
          };
          for (const token of supplied) {
            const matches = values.filter(
              (value) => value && (String(value.value_id) === token || value.name === token),
            );
            if (
              !matches.length ||
              matches.some(
                (value) =>
                  id(value?.value_id) === undefined ||
                  typeof value?.name !== 'string' ||
                  value?.value_id === 0,
              )
            ) {
              if (!matches.length && info.support_search_value === true)
                issue(
                  'METADATA_ATTRIBUTE_SEARCH_REQUIRED',
                  `attributes.${key}`,
                  'Thuộc tính dùng danh sách tra cứu; cần lấy giá trị từ API tìm kiếm trước khi ánh xạ.',
                );
              issue(
                'SOURCE_ATTRIBUTE_VALUE_UNRESOLVED',
                `attributes.${key}`,
                'Giá trị chưa có ánh xạ rõ ràng; không suy đoán giá trị tùy chỉnh.',
              );
              continue;
            }
            if (matches.length !== 1) {
              issue(
                'SOURCE_ATTRIBUTE_VALUE_AMBIGUOUS',
                `attributes.${key}`,
                'Giá trị nguồn khớp nhiều ID/tên khác nhau.',
              );
              continue;
            }
            const value = matches[0]!;
            if (
              (value.value_unit !== undefined && typeof value.value_unit !== 'string') ||
              (info.format_type === 2 &&
                (!value.value_unit || typeof value.value_unit !== 'string'))
            ) {
              issue(
                'SOURCE_ATTRIBUTE_UNIT_UNRESOLVED',
                `attributes.${key}`,
                'Thiếu đơn vị chính xác của giá trị thuộc tính.',
              );
              continue;
            }
            if (wire.attribute_value_list.some((entry) => entry.value_id === value.value_id)) {
              issue(
                'SOURCE_ATTRIBUTE_VALUE_DUPLICATE',
                `attributes.${key}`,
                'Một giá trị thuộc tính được chọn nhiều lần.',
              );
              continue;
            }
            wire.attribute_value_list.push({
              value_id: value.value_id as number,
              original_value_name: value.name as string,
              ...(typeof value.value_unit === 'string' ? { value_unit: value.value_unit } : {}),
            });
            if (value.child_attribute_list !== undefined) {
              if (!Array.isArray(value.child_attribute_list))
                issue(
                  'METADATA_ATTRIBUTE_TREE_INVALID',
                  `attributes.${key}`,
                  'Cây thuộc tính con không hợp lệ.',
                );
              else visit(value.child_attribute_list, depth + 1);
            }
          }
          const prior = resolved.get(attributeId);
          if (prior && JSON.stringify(prior) !== JSON.stringify(wire))
            issue(
              'SOURCE_ATTRIBUTE_BRANCH_CONFLICT',
              `attributes.${key}`,
              'Hai nhánh cha yêu cầu ánh xạ khác nhau cho cùng thuộc tính.',
            );
          else resolved.set(attributeId, wire);
        }
        active.delete(node);
      }
    };
    visit(categories[0]!.attribute_tree as unknown[]);
    for (const key of Object.keys(document.attributes))
      if (!visited.has(key))
        issue(
          'SOURCE_ATTRIBUTE_INACTIVE_OR_UNKNOWN',
          `attributes.${key}`,
          'Thuộc tính không thuộc nhánh đã chọn hoặc chưa có metadata.',
        );
    result.resolved.attributes = [...resolved.values()]
      .filter((entry) => entry.attribute_value_list.length > 0)
      .sort((a, b) => a.attribute_id - b.attribute_id);
    for (const problem of validateAttributeSelection(categories[0]!.attribute_tree, result.resolved.attributes).issues)
      issue(problem.code, problem.path, 'Giá trị đã ánh xạ không đạt quy tắc hiện tại của cây thuộc tính; giữ nguyên nguồn để đối chiếu.');
  }
  result.compatible = result.issues.length === 0;
  return result;
}

function validGtin(value: string) {
  if (!/^\d{8,14}$/.test(value)) return false;
  const digits = [...value].map(Number),
    check = digits.pop()!;
  const total = digits
    .reverse()
    .reduce((sum, digit, index) => sum + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === check;
}

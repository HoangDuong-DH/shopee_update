import { canonicalJson } from '@shopee/domain';

/** Pure validation of an exact wire selection against the current category tree.
 * Sources: Open Platform guides 209 §§2.2–2.5 and 211 §2.2; get_attribute_tree/add_item.
 * Snapshot 2026-09-08. Tree freshness/shop authorization remain the caller's responsibility.
 * No values, labels, units, dates, branch choices or shop limits are inferred or rewritten.
 */
export type AttributeSelectionIssue = {
  code: string;
  path: string;
  attributeId?: number;
};
export type AttributeSelectionResult = {
  valid: boolean;
  issues: AttributeSelectionIssue[];
  activeAttributeIds: number[];
};
type Raw = Record<string, any>;
type Node = {
  id: number;
  mandatory: boolean;
  info: Raw;
  values: Map<number, { raw: Raw; children: Node[] }>;
};
type Selection = {
  attribute_id: number;
  attribute_value_list: { value_id: number; original_value_name?: string; value_unit?: string }[];
};
const object = (value: unknown): value is Raw =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export function validateAttributeSelection(
  attributeTree: unknown,
  attributeList: unknown,
): AttributeSelectionResult {
  const issues: AttributeSelectionIssue[] = [],
    activeIds = new Set<number>(),
    activeDefinitions = new Map<number, string>();
  const issue = (code: string, path: string, attributeId?: number) => {
    if (!issues.some((entry) => entry.code === code && entry.path === path))
      issues.push({ code, path, ...(attributeId === undefined ? {} : { attributeId }) });
  };
  // Local resource bounds, not marketplace quotas. An overlarge tree fails explicitly.
  const stack = new WeakSet<object>();
  let count = 0;
  const parse = (
    raw: unknown,
    path: string,
    depth: number,
    ancestors: Set<number> = new Set(),
  ): Node[] => {
    if (!Array.isArray(raw) || depth > 30 || raw.length > 10000 || count + raw.length > 10000) {
      issue('ATTRIBUTE_TREE_UNVERIFIED', path);
      return [];
    }
    const result: Node[] = [],
      siblings = new Set<number>();
    for (const [index, item] of raw.entries()) {
      count++;
      const here = `${path}.${index}`;
      if (
        !object(item) ||
        stack.has(item) ||
        !integer(item.attribute_id, 1) ||
        typeof item.mandatory !== 'boolean' ||
        !object(item.attribute_info)
      ) {
        issue('ATTRIBUTE_TREE_UNVERIFIED', here);
        continue;
      }
      if (siblings.has(item.attribute_id) || ancestors.has(item.attribute_id)) {
        issue('ATTRIBUTE_TREE_UNVERIFIED', here, item.attribute_id);
        continue;
      }
      siblings.add(item.attribute_id);
      stack.add(item);
      const node: Node = {
        id: item.attribute_id,
        mandatory: item.mandatory,
        info: item.attribute_info,
        values: new Map(),
      };
      const values = item.attribute_value_list ?? [];
      if (!Array.isArray(values) || count + values.length > 10000)
        issue('ATTRIBUTE_TREE_UNVERIFIED', here, node.id);
      else
        for (const [valueIndex, value] of values.entries()) {
          count++;
          const valuePath = `${here}.attribute_value_list.${valueIndex}`;
          if (
            !object(value) ||
            !integer(value.value_id, 1) ||
            !nonblank(value.name) ||
            node.values.has(value.value_id) ||
            (value.value_unit !== undefined && typeof value.value_unit !== 'string')
          ) {
            issue('ATTRIBUTE_TREE_UNVERIFIED', valuePath, node.id);
            continue;
          }
          const children =
            value.child_attribute_list === undefined
              ? []
              : parse(
                  value.child_attribute_list,
                  `${valuePath}.child_attribute_list`,
                  depth + 1,
                  new Set([...ancestors, node.id]),
                );
          node.values.set(value.value_id, { raw: value, children });
        }
      stack.delete(item);
      result.push(node);
    }
    return result;
  };
  const nodes = parse(attributeTree, 'attributeTree', 0),
    chosen = new Map<number, Selection>();
  if (!Array.isArray(attributeList) || attributeList.length > 1000)
    issue('ATTRIBUTE_SELECTION_INVALID', 'attributeList');
  else
    for (const [index, row] of attributeList.entries()) {
      const path = `attributeList.${index}`;
      if (
        !object(row) ||
        !integer(row.attribute_id, 1) ||
        Object.keys(row).some((key) => !['attribute_id', 'attribute_value_list'].includes(key)) ||
        !Array.isArray(row.attribute_value_list) ||
        row.attribute_value_list.length === 0 ||
        row.attribute_value_list.length > 1000
      ) {
        issue('ATTRIBUTE_SELECTION_INVALID', path);
        continue;
      }
      if (chosen.has(row.attribute_id)) {
        issue('ATTRIBUTE_DUPLICATE', path, row.attribute_id);
        continue;
      }
      let valid = true;
      const identities = new Set<string>();
      for (const [valueIndex, value] of row.attribute_value_list.entries()) {
        const valuePath = `${path}.attribute_value_list.${valueIndex}`;
        if (
          !object(value) ||
          Object.keys(value).some(
            (key) => !['value_id', 'original_value_name', 'value_unit'].includes(key),
          ) ||
          !integer(value.value_id) ||
          (value.original_value_name !== undefined && !nonblank(value.original_value_name)) ||
          (value.value_unit !== undefined && typeof value.value_unit !== 'string')
        ) {
          issue('ATTRIBUTE_SELECTION_INVALID', valuePath, row.attribute_id);
          valid = false;
          continue;
        }
        const identity = value.value_id
          ? String(value.value_id)
          : JSON.stringify([0, value.original_value_name, value.value_unit ?? '']);
        if (identities.has(identity)) {
          issue('ATTRIBUTE_VALUE_DUPLICATE', valuePath, row.attribute_id);
          valid = false;
        }
        identities.add(identity);
      }
      if (valid) chosen.set(row.attribute_id, row as Selection);
    }
  const validateCustom = (value: string, info: Raw): boolean => {
    if (info.input_validation_type === 0 || info.input_validation_type === 2)
      return nonblank(value);
    if (info.input_validation_type === 1)
      return /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
    if (info.input_validation_type === 3)
      return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number.isFinite(Number(value));
    // Write contract is Unix seconds. Readable DD/MM/YYYY and MM/YYYY must not be guessed/converted.
    return (
      [0, 1].includes(info.date_format_type) &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number.isFinite(new Date(Number(value) * 1000).getTime())
    );
  };
  const visit = (list: Node[]) => {
    for (const node of list) {
      activeIds.add(node.id);
      const definition = canonicalJson({
        mandatory: node.mandatory,
        info: node.info,
        values: [...node.values]
          .sort(([a], [b]) => a - b)
          .map(([id, entry]) => ({ id, name: entry.raw.name, unit: entry.raw.value_unit ?? '' })),
      });
      if (activeDefinitions.has(node.id) && activeDefinitions.get(node.id) !== definition) {
        issue('ATTRIBUTE_BRANCH_CONFLICT', `attributes.${node.id}`, node.id);
        continue;
      }
      activeDefinitions.set(node.id, definition);
      const selection = chosen.get(node.id),
        path = `attributes.${node.id}`,
        info = node.info;
      if (!selection) {
        if (node.mandatory) issue('MANDATORY_ATTRIBUTE_MISSING', path, node.id);
        continue;
      }
      const single = [1, 2, 3].includes(info.input_type);
      const maximum = info.max_value_count === undefined && single ? 1 : info.max_value_count;
      const units = info.attribute_unit_list ?? [];
      if (
        ![1, 2, 3, 4, 5].includes(info.input_type) ||
        ![0, 1, 2, 3, 4].includes(info.input_validation_type) ||
        ![1, 2].includes(info.format_type) ||
        !integer(maximum, 1) ||
        !Array.isArray(units) ||
        units.some((unit) => !nonblank(unit)) ||
        new Set(units).size !== units.length ||
        (info.input_validation_type === 4 && ![0, 1].includes(info.date_format_type))
      ) {
        issue('ATTRIBUTE_CONSTRAINT_UNVERIFIED', path, node.id);
        continue;
      }
      if (
        selection.attribute_value_list.length > maximum ||
        (single && selection.attribute_value_list.length > 1)
      ) {
        issue('ATTRIBUTE_COUNT_INVALID', path, node.id);
        continue;
      }
      for (const [index, value] of selection.attribute_value_list.entries()) {
        const valuePath = `${path}.${index}`,
          actual = node.values.get(value.value_id);
        let valid = true;
        if (value.value_id === 0) {
          if (
            ![2, 3, 5].includes(info.input_type) ||
            !nonblank(value.original_value_name) ||
            !validateCustom(value.original_value_name, info)
          ) {
            issue('CUSTOM_ATTRIBUTE_UNVERIFIED', valuePath, node.id);
            valid = false;
          }
        } else if (!actual || info.input_type === 3) {
          issue('ATTRIBUTE_VALUE_CHANGED', valuePath, node.id);
          valid = false;
        } else if (
          value.original_value_name !== undefined &&
          value.original_value_name !== actual.raw.name &&
          !(
            Array.isArray(actual.raw.multi_lang) &&
            actual.raw.multi_lang.some(
              (translated: unknown) =>
                object(translated) && translated.value === value.original_value_name,
            )
          )
        ) {
          issue('ATTRIBUTE_VALUE_CHANGED', valuePath, node.id);
          valid = false;
        }
        const unit = value.value_unit ?? '';
        const invalidUnit =
          info.format_type === 1
            ? !!unit
            : value.value_id === 0
              ? !unit || !units.includes(unit)
              : !!unit &&
                (!nonblank(actual?.raw.value_unit) ||
                  actual!.raw.value_unit !== unit ||
                  (units.length > 0 && !units.includes(unit)));
        if (invalidUnit) {
          issue('ATTRIBUTE_UNIT_CHANGED', valuePath, node.id);
          valid = false;
        }
        if (valid && actual) visit(actual.children);
      }
    }
  };
  visit(nodes);
  for (const [id] of chosen)
    if (!activeIds.has(id)) issue('ATTRIBUTE_INACTIVE_OR_UNKNOWN', `attributes.${id}`, id);
  return { valid: issues.length === 0, issues, activeAttributeIds: [...activeIds] };
}

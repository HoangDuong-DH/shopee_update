import { expect, it } from 'vitest';
import { validateAttributeSelection } from '../../packages/shopee/src/attribute-validation.js';

const field = (id: number, inputType = 1, extra: any = {}): any => ({
  attribute_id: id,
  name: 'Thuộc tính ' + id,
  mandatory: false,
  attribute_info: {
    input_type: inputType,
    input_validation_type: 0,
    format_type: 1,
    ...([4, 5].includes(inputType) ? { max_value_count: 3 } : {}),
    ...extra,
  },
  attribute_value_list: inputType === 3 ? [] : [{ value_id: id * 10, name: 'Giá trị ' + id }],
});
const selection = (id: number, ...values: any[]) => ({
  attribute_id: id,
  attribute_value_list: values.map((value) =>
    typeof value === 'number' ? { value_id: value } : value,
  ),
});
const custom = (name: string, unit?: string) => ({
  value_id: 0,
  original_value_name: name,
  ...(unit === undefined ? {} : { value_unit: unit }),
});
const codes = (tree: any, chosen: any) =>
  validateAttributeSelection(tree, chosen).issues.map((issue) => issue.code);

it('preserves exact wire values and order while validating a valid active mandatory child', () => {
  const parent = field(7),
    child = { ...field(8), mandatory: true };
  parent.attribute_value_list[0]!.child_attribute_list = [child];
  const tree = [parent],
    chosen = [selection(8, 80), selection(7, 70)],
    before = structuredClone({ tree, chosen });
  expect(validateAttributeSelection(tree, chosen)).toMatchObject({
    valid: true,
    activeAttributeIds: [7, 8],
    issues: [],
  });
  expect({ tree, chosen }).toEqual(before);
  expect(codes(tree, [selection(7, 70)])).toContain('MANDATORY_ATTRIBUTE_MISSING');
  expect(codes(tree, [selection(8, 80)])).toContain('ATTRIBUTE_INACTIVE_OR_UNKNOWN');
  expect(validateAttributeSelection(tree, []).valid).toBe(true);
});

it('requires every selected ancestor and does not activate children of an invalid parent', () => {
  const a = field(1),
    b = field(2),
    c = { ...field(3), mandatory: true };
  a.attribute_value_list[0]!.child_attribute_list = [b];
  b.attribute_value_list[0]!.child_attribute_list = [c];
  expect(
    validateAttributeSelection([a], [selection(1, 10), selection(2, 20), selection(3, 30)]).valid,
  ).toBe(true);
  expect(codes([a], [selection(1, 11), selection(2, 20), selection(3, 30)])).toContain(
    'ATTRIBUTE_VALUE_CHANGED',
  );
  expect(codes([a], [selection(1, 11), selection(2, 20), selection(3, 30)])).toContain(
    'ATTRIBUTE_INACTIVE_OR_UNKNOWN',
  );
});

it.each([1, 2, 3, 4, 5])(
  'implements documented input type %i without inferred custom choices',
  (type) => {
    const tree = [field(7, type)],
      preset = [selection(7, 70)],
      userValue = [selection(7, custom('nguồn người dùng'))];
    expect(validateAttributeSelection(tree, preset).valid).toBe(type !== 3);
    expect(validateAttributeSelection(tree, userValue).valid).toBe([2, 3, 5].includes(type));
  },
);

it('enforces current maxima and single-value semantics; a missing multi maximum is unknown', () => {
  const single = field(7, 2, { max_value_count: 5 }),
    multi = field(8, 5, { max_value_count: 2 });
  expect(codes([single], [selection(7, 70, custom('second'))])).toContain(
    'ATTRIBUTE_COUNT_INVALID',
  );
  expect(
    validateAttributeSelection([multi], [selection(8, custom('one'), custom('two'))]).valid,
  ).toBe(true);
  expect(codes([multi], [selection(8, 80, custom('one'), custom('two'))])).toContain(
    'ATTRIBUTE_COUNT_INVALID',
  );
  delete multi.attribute_info.max_value_count;
  expect(codes([multi], [selection(8, 80)])).toContain('ATTRIBUTE_CONSTRAINT_UNVERIFIED');
});

it('rejects duplicate attributes, duplicate predefined IDs and duplicate custom values but permits distinct custom values', () => {
  const node = field(7, 5);
  expect(codes([node], [selection(7, 70), selection(7, 70)])).toContain('ATTRIBUTE_DUPLICATE');
  expect(codes([node], [selection(7, 70, 70)])).toContain('ATTRIBUTE_VALUE_DUPLICATE');
  expect(codes([node], [selection(7, custom('a'), custom('a'))])).toContain(
    'ATTRIBUTE_VALUE_DUPLICATE',
  );
  expect(validateAttributeSelection([node], [selection(7, custom('a'), custom('b'))]).valid).toBe(
    true,
  );
});

it.each([
  [0, 'Nội dung nguyên văn', true],
  [1, '-12', true],
  [1, '12.5', false],
  [1, '9007199254740992', false],
  [2, 'chuỗi tiếng Việt', true],
  [3, '-12.5', true],
  [3, '12,5', false],
  [3, 'Infinity', false],
  [4, '1634526913', true],
  [4, '31/06/2021', false],
  [4, '06/2021', false],
  [4, 'NaN', false],
])('validates custom type %i for exact value %s', (type, text, valid) => {
  expect(
    validateAttributeSelection(
      [
        field(7, 3, {
          input_validation_type: type,
          ...(type === 4 ? { date_format_type: 0 } : {}),
        }),
      ],
      [selection(7, custom(String(text)))],
    ).valid,
  ).toBe(valid);
});

it('requires returned units for quantitative values and rejects changed predefined labels or units', () => {
  const node = field(7, 2, { format_type: 2, attribute_unit_list: ['g', 'kg'] });
  node.attribute_value_list = [{ value_id: 70, name: '5kg', value_unit: 'kg' }];
  expect(
    validateAttributeSelection([node], [selection(7, { value_id: 70, value_unit: 'kg' })]).valid,
  ).toBe(true);
  expect(validateAttributeSelection([node], [selection(7, 70)]).valid).toBe(true);
  expect(validateAttributeSelection([node], [selection(7, custom('12', 'g'))]).valid).toBe(true);
  for (const value of [
    custom('12'),
    custom('12', 'lb'),
    { value_id: 70, value_unit: 'g' },
    { value_id: 70, original_value_name: 'different', value_unit: 'kg' },
  ])
    expect(validateAttributeSelection([node], [selection(7, value)]).valid).toBe(false);
});

it('supports shared child IDs in separate parent branches and rejects conflicting simultaneously active definitions', () => {
  const parent = field(7, 4),
    child = { ...field(8), mandatory: true };
  parent.attribute_value_list = [
    { value_id: 70, name: 'Nhánh A', child_attribute_list: [child] },
    { value_id: 71, name: 'Nhánh B', child_attribute_list: [structuredClone(child)] },
  ];
  for (const values of [[70], [71], [70, 71]])
    expect(
      validateAttributeSelection([parent], [selection(7, ...values), selection(8, 80)]).valid,
    ).toBe(true);
  parent.attribute_value_list[1].child_attribute_list[0].attribute_value_list = [
    { value_id: 81, name: 'Khác' },
  ];
  expect(validateAttributeSelection([parent], [selection(7, 70), selection(8, 80)]).valid).toBe(
    true,
  );
  expect(validateAttributeSelection([parent], [selection(7, 71), selection(8, 81)]).valid).toBe(
    true,
  );
  expect(codes([parent], [selection(7, 70, 71), selection(8, 80)])).toContain(
    'ATTRIBUTE_BRANCH_CONFLICT',
  );
});

it('never guesses an ID from a label or approves a searchable value absent from supplied metadata', () => {
  const node = field(7, 1, { support_search_value: true });
  expect(codes([node], [selection(7, 71)])).toContain('ATTRIBUTE_VALUE_CHANGED');
  expect(codes([node], [selection(7, { value_id: '70' })])).toContain(
    'ATTRIBUTE_SELECTION_INVALID',
  );
  expect(codes([node], [selection(8, 70)])).toContain('ATTRIBUTE_INACTIVE_OR_UNKNOWN');
});

it('compares shared active definitions independently of metadata object key order', () => {
  const parent = field(7, 4),
    a = { ...field(8), mandatory: true },
    b = structuredClone(a);
  b.attribute_info = { format_type: 1, input_validation_type: 0, input_type: 1 };
  parent.attribute_value_list = [
    { value_id: 70, name: 'A', child_attribute_list: [a] },
    { value_id: 71, name: 'B', child_attribute_list: [b] },
  ];
  expect(validateAttributeSelection([parent], [selection(7, 70, 71), selection(8, 80)]).valid).toBe(
    true,
  );
});

it('fails closed on missing or unknown constraints, malformed tree, duplicate metadata IDs and cycles', () => {
  for (const patch of [
    { input_type: 0 },
    { input_validation_type: 7 },
    { format_type: 0 },
    { input_type: 5, max_value_count: 0 },
    { input_type: 3, input_validation_type: 4, date_format_type: 8 },
  ])
    expect(
      validateAttributeSelection([field(7, 2, patch)], [selection(7, custom('12'))]).valid,
    ).toBe(false);
  for (const raw of [null, {}, [{}], [field(7), field(7)]])
    expect(validateAttributeSelection(raw, []).valid).toBe(false);
  const a = field(7);
  a.attribute_value_list[0]!.child_attribute_list = [a];
  expect(codes([a], [selection(7, 70)])).toContain('ATTRIBUTE_TREE_UNVERIFIED');
});

it('reports mandatory empty selections and supports a legitimately empty category without defaults', () => {
  expect(validateAttributeSelection([], [])).toEqual({
    valid: true,
    issues: [],
    activeAttributeIds: [],
  });
  expect(codes([{ ...field(7), mandatory: true }], [])).toContain('MANDATORY_ATTRIBUTE_MISSING');
  expect(codes([field(7)], [selection(7)])).toContain('ATTRIBUTE_SELECTION_INVALID');
});

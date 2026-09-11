import { describe, expect, it } from 'vitest';
import { selectWordParagraphs } from '../../apps/web/src/word-assignment.js';

describe('explicit Word paragraph assignment', () => {
  const paragraphs = ['  Tên sản phẩm  ', '', 'Câu mở đầu', 'Nội dung\n  xuống dòng ', ''];

  it('preserves spaces, empty paragraphs, and line breaks within the selected source range', () => {
    expect(selectWordParagraphs(paragraphs, 2, 5, 'body')).toEqual({
      text: '\nCâu mở đầu\nNội dung\n  xuống dòng \n',
    });
    expect(paragraphs).toEqual([
      '  Tên sản phẩm  ',
      '',
      'Câu mở đầu',
      'Nội dung\n  xuống dòng ',
      '',
    ]);
  });

  it('assigns a single-line title without trimming the supplied text', () => {
    expect(selectWordParagraphs(paragraphs, 1, 1, 'title')).toEqual({ text: '  Tên sản phẩm  ' });
  });

  it('rejects invalid or out-of-range selections instead of silently shortening them', () => {
    for (const [start, end] of [
      [0, 1],
      [1, 6],
      [3, 2],
      [1.5, 2],
      [NaN, 2],
    ]) {
      expect(selectWordParagraphs(paragraphs, start, end, 'body')).toHaveProperty('error');
    }
  });

  it('does not flatten a multiline source into the single-line title field', () => {
    expect(selectWordParagraphs(paragraphs, 1, 3, 'title')).toHaveProperty('error');
    expect(selectWordParagraphs(paragraphs, 4, 4, 'title')).toHaveProperty('error');
  });
});

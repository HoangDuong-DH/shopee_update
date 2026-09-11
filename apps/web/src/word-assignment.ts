export type WordTarget = 'title' | 'headline' | 'body';
export function selectWordParagraphs(
  paragraphs: readonly string[],
  start: number,
  end: number,
  target: WordTarget,
): { text: string } | { error: string } {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > paragraphs.length
  )
    return { error: 'Chọn số đoạn bắt đầu và kết thúc trong tệp Word đang mở.' };
  const text = paragraphs.slice(start - 1, end).join('\n');
  if (target === 'title' && (start !== end || /[\r\n]/.test(text)))
    return {
      error: 'Tiêu đề chỉ nhận một đoạn có một dòng. Hãy chọn đúng đoạn tiêu đề đã chuẩn bị.',
    };
  return { text };
}

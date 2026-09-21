import sharp from 'sharp';

/** Programmatic QA card. The final 5x7 glyph is a critical SKU digit, not artwork. */
export async function technicalImage(lastDigit: '0' | '8' = '0'): Promise<Buffer> {
  const width = 128,
    height = 128;
  const pixels = Buffer.alloc(width * height * 3, 242);
  const dot = (x: number, y: number, rgb: number[]) => {
    const offset = (y * width + x) * 3;
    rgb.forEach((channel, i) => {
      pixels[offset + i] = channel;
    });
  };
  for (let y = 12; y < 92; y++)
    for (let x = 12; x < 116; x++) dot(x, y, [24 + x, 73 + (y % 22), 120 + (x % 35)]);
  for (let x = 0; x < width; x++) dot(x, 1, [20, 20, 20]);
  const digit =
    lastDigit === '0'
      ? ['01110', '10001', '10011', '10101', '11001', '10001', '01110']
      : ['01110', '10001', '10001', '01110', '10001', '10001', '01110'];
  digit.forEach((row, y) =>
    [...row].forEach((value, x) => {
      if (value === '1') dot(x + 110, y + 112, [0, 0, 0]);
    }),
  );
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

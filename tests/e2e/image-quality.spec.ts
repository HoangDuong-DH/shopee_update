import { openWorkspaceTool } from './workspace-navigation.js';
import { test, expect } from '@playwright/test';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { resolve } from 'node:path';
let server: ChildProcess, url: string, id: string;
test.beforeAll(async () => {
  server = fork(resolve('tests/e2e/image-quality-server.mts'), [], {
    execPath: process.execPath,
    execArgv: ['--conditions=development', '--import', 'tsx'],
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  } as ForkOptions);
  const ready = await new Promise<any>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('QC fixture timeout')), 30000);
    server.on('message', (v: any) => {
      if (v.ready) {
        clearTimeout(timer);
        done(v);
      }
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error('QC fixture exited ' + code));
    });
    server.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  });
  url = ready.url;
  id = ready.id;
});
test.afterAll(async () => {
  if (server?.connected) {
    server.send('stop');
    await new Promise<void>((done) => {
      server.once('exit', () => done());
      setTimeout(done, 15000).unref();
    });
  }
});
test('nontechnical QC shows the exact pair, saves an explicit review, survives reload and fits mobile', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await openWorkspaceTool(page, 'Kiểm tra ảnh');
  await page.getByRole('button', { name: /Ảnh bìa · 1/ }).click();
  await expect(page.getByRole('heading', { name: 'Ảnh bìa · Listing 990001' })).toBeVisible();
  for (const side of ['source', 'output']) {
    const img = page.locator(`img[src="/v1/image-qc/${id}/image/${side}"]`);
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(500);
  }
  const accept = page.getByRole('button', { name: 'Xác nhận ảnh đúng nội dung' });
  await expect(accept).toBeDisabled();
  await page.getByLabel('Người đối chiếu').fill('Nhân viên QA giả lập');
  await page
    .getByLabel('Nhận xét cụ thể')
    .fill('Ca thử giao diện: đúng cặp ảnh, chỉ khác nén JPEG.');
  await accept.click();
  await expect(page.getByText('Đạt qua đối chiếu', { exact: true }).first()).toBeVisible();
  await page.reload();
  await openWorkspaceTool(page, 'Kiểm tra ảnh');
  await page.getByRole('button', { name: /Ảnh bìa · 1/ }).click();
  await expect(page.getByText(/Nhận xét đã lưu: Ca thử giao diện/)).toBeVisible();
  await expect(accept).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('image-qc-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Ảnh bìa · Listing 990001' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('image-qc-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

import { readFile, writeFile } from 'node:fs/promises';
const root = '.local/acceptance-20260914/prepared-verification/';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
function cases(report: any) {
  const rows: any[] = [];
  function visit(suite: any) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) rows.push({ key: [spec.file, spec.title, test.projectName].join('::'), state: test.results.at(-1)?.status });
    for (const child of suite.suites ?? []) visit(child);
  }
  report.suites.forEach(visit); return rows;
}
const browser = new Map<string, any>();
for (const file of ['existing-browser.json', 'mobile-regression-fixed.json'])
  for (const row of cases(await json(root + file))) browser.set(row.key, row);
const browserCases = [...browser.values()];
const business = await json('.local/acceptance-20260914/prepared-business-latest.json');
const controls = cases(await json(root + 'prepared-controls-ui-results.json'));
const tests = await json(root + 'test-results.json');
const checks = await json(root + 'verification.json');
const before = await json(root + 'protected-before.json'), after = await json(root + 'protected-after.json');
const protectedUnchanged = JSON.stringify(before.tables) === JSON.stringify(after.tables);
if (browserCases.length !== 65 || browserCases.some(row => row.state !== 'passed') || controls.length !== 3 || controls.some(row => row.state !== 'passed') || business.outcomes.length !== 15 || business.outcomes.some((row: any) => row.status !== 'passed') || tests.numPassedTests !== 490 || tests.numFailedTests || checks.results.some((row: any) => row.exitCode !== 0) || !protectedUnchanged)
  throw new Error('Verification is incomplete. Do not publish a green summary.');
const summary = {
  observedAt: new Date().toISOString(), passed: true, productionAccepted: false,
  unitIntegration: { passed: 490, report: root + 'test-results.json' },
  legacy: { passed: 7, log: root + 'verify-final.log' },
  oldBrowserRegression: { passed: 65, reports: [root + 'existing-browser.json', root + 'mobile-regression-fixed.json'], note: 'Initial mobile failures were fixed and affected files rerun; union includes no skipped or failed case.' },
  newStatefulBusinessBrowser: { passed: 15, source: business.evidenceRoot, liveShopee: false },
  newRecoveryUiFixtures: { passed: 3, report: root + 'prepared-controls-ui-results.json', apiMocked: true },
  typecheckBuild: { passed: true, report: root + 'verification.json', postMobileCssTypecheckAndBuild: 'Passed again after the CSS fix; recorded in the execution tool output.' },
  protectedMainData: { unchanged: protectedUnchanged, tables: Object.keys(before.tables), before: root + 'protected-before.json', after: root + 'protected-after.json' },
};
await writeFile(root + 'final-verification.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ passed: true, unitIntegration: 490, legacy: 7, oldBrowser: 65, newBusinessBrowser: 15, recoveryUiFixtures: 3, protectedMainUnchanged: true }));

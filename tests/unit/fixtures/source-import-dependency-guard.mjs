import { registerHooks } from 'node:module';
// Fixture-only startup guard: lightweight source kinds must not load the workbook dependency.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'exceljs') throw Error('UNRELATED_EXCEL_PARSER_LOADED');
    return nextResolve(specifier, context);
  },
});

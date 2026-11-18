/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'products-do-not-import-demos',
      comment: 'Product code does not import a demo entrypoint. Demos sit on top of the modules.',
      severity: 'error',
      from: { path: '^src/products/' },
      to: { path: '^src/demos/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|hw-)' },
    tsPreCompilationDeps: true,
  },
};

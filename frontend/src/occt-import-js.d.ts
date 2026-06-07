// occt-import-js ships no type declarations. The default export is an
// emscripten factory that resolves to the OpenCASCADE module instance;
// occtImport.ts narrows that instance to the functions it actually calls.
declare module "occt-import-js" {
  const occtimportjs: () => Promise<unknown>;
  export default occtimportjs;
}

// occt-import-js ships no type declarations. The default export is an
// emscripten factory that resolves to the OpenCASCADE module instance;
// occtImport.ts narrows that instance to the functions it actually calls.
// The optional config carries emscripten's `locateFile`, which the browser
// build uses to point at the Vite-served .wasm.
declare module "occt-import-js" {
  const occtimportjs: (config?: {
    locateFile?: (path: string) => string;
  }) => Promise<unknown>;
  export default occtimportjs;
}

import { CadImportError, importStepBytes } from './step-import';
import type { OcctFactory, StepWorkerRequest, StepWorkerResponse } from './step-types';

const scope = globalThis as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<StepWorkerRequest>) => void) | null;
  postMessage: (message: StepWorkerResponse, transfer?: Transferable[]) => void;
};

// The pinned, CSP-compatible loader is packaged in public/vendor.
// It creates no Function/eval wrappers and resolves only its adjacent local WASM.
let started = false;
scope.onmessage = async event => {
  if (started || event.data?.type !== 'import-step') return;
  started = true;
  try {
    const base = new URL('/vendor/occt/', scope.location.href);
    const module = await import(/* @vite-ignore */ new URL('occt-import-js.mjs', base).href) as { default?: OcctFactory };
    if (!module.default) throw new CadImportError('The bundled CAD engine is unavailable. Reinstall or rebuild the viewer.');
    const importer = await module.default({
      locateFile: file => {
        if (file !== 'occt-import-js.wasm') throw new CadImportError('The CAD engine requested an unexpected resource.');
        return new URL(file, base).href;
      },
      // Kernel diagnostics can include source names/content. Keep them out of logs.
      print: () => {}, printErr: () => {},
    });
    const result = await importStepBytes(importer, new Uint8Array(event.data.bytes), event.data.expectedHash, event.data.cadNodePath, event.data.sourceToPart);
    scope.postMessage({ type: 'step-result', result }, [result.positions.buffer, result.normals.buffer, result.indices.buffer] as ArrayBuffer[]);
  } catch (error) {
    scope.postMessage({ type: 'step-error', message: error instanceof CadImportError ? error.message : 'The local CAD engine could not start or import this source. Check the packaged viewer assets and supported file limits.' });
  }
};

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OCCT_VERSION = '0.0.23';
export const OCCT_GLUE_SHA256 = '3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379';

/**
 * The pinned upstream Emscripten glue generates two embind wrappers with the
 * Function constructor. MV3 forbids that even when WASM itself is permitted.
 * Replace those fixed wrapper builders with equivalent ordinary closures.
 * This is a build-time, source-hash-guarded compatibility patch, never a runtime
 * interpreter or an evaluation of document/STEP content. Upgrade deliberately.
 */
export function createCspCompatibleOcct(source) {
  if (createHash('sha256').update(source).digest('hex') !== OCCT_GLUE_SHA256) {
    throw new Error('The OCCT JavaScript loader changed. Review the pinned CSP compatibility patch before building.');
  }
  const replaceRange = (input, start, end, replacement) => {
    const from = input.indexOf(start), to = input.indexOf(end, from + start.length);
    if (from < 0 || to < 0 || input.indexOf(start, from + 1) !== -1) throw new Error('The pinned OCCT wrapper shape changed.');
    return input.slice(0, from) + replacement + input.slice(to);
  };
  let result = replaceRange(source, 'function newFunc(', 'var ensureOverloadTable=', `
function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
  if(argTypes.length<2||isAsync){throwBindingError('Unsupported asynchronous or invalid CAD binding.');}
  var isClassMethod=argTypes[1]!==null&&classType!==null;
  var needsStack=usesDestructorStack(argTypes);
  return createNamedFunction(humanName,function(...args){
    var destructors=needsStack?[]:null;
    var directDestructors=[];
    var wired=[cppTargetFunc];
    var result;
    function convert(type,value){
      var converted=type.toWireType(destructors,value);
      if(!needsStack&&type.destructorFunction!==null){directDestructors.push([type.destructorFunction,converted]);}
      return converted;
    }
    try{
      if(isClassMethod){wired.push(convert(argTypes[1],this));}
      for(var i=2;i<argTypes.length;i++){wired.push(convert(argTypes[i],args[i-2]));}
      result=cppInvokerFunc(...wired);
    }finally{
      if(needsStack){runDestructors(destructors);}
      else{for(var entry of directDestructors){entry[0](entry[1]);}}
    }
    return argTypes[0].name!=='void'?argTypes[0].fromWireType(result):undefined;
  });
}
`);
  result = replaceRange(result, 'var __emval_get_method_caller=', 'var __emval_get_property=', `
var __emval_get_method_caller=(argCount,argTypes,kind)=>{
  var types=emval_lookupTypes(argCount,argTypes);
  var retType=types.shift();
  var invokerFunction=function(obj,func,destructorsRef,args){
    var offset=0;
    var values=types.map(type=>{var value=type.readValueFromPointer(args+offset);offset+=type.argPackAdvance;return value;});
    var result=kind===1?Reflect.construct(func,values):kind===0?Reflect.apply(func,obj,values):Reflect.apply(func,values.shift(),values);
    if(!retType.isVoid){return emval_returnValue(retType,destructorsRef,result);}
  };
  return emval_addMethodCaller(createNamedFunction('cadMethodCaller',invokerFunction));
};
`);
  result = result.replace('var emval_get_global=()=>{if(typeof globalThis=="object"){return globalThis}return function(){return Function}()("return this")()};', 'var emval_get_global=()=>globalThis;');
  if (/\bFunction\s*[(,)]|return Function\b|\beval\s*\(/.test(result)) throw new Error('The CAD loader still contains a string-code-generation path.');
  return `/* occt-import-js ${OCCT_VERSION}, LGPL-2.1; bundled locally.\n * Build compatibility patch: ordinary embind closures for strict Chrome MV3 CSP.\n * Upstream: https://github.com/kovacsv/occt-import-js\n * Rebuild: scripts/prepare-cad-runtime.mjs; accompanying license in this directory. */\n${result}`;
}

export async function prepareCadRuntime(projectRoot) {
  const root = resolve(projectRoot);
  const sourceDirectory = resolve(root, 'node_modules/occt-import-js');
  const manifest = JSON.parse(await readFile(resolve(sourceDirectory, 'package.json'), 'utf8'));
  if (manifest.version !== OCCT_VERSION) throw new Error(`Expected occt-import-js ${OCCT_VERSION}. Review the CAD runtime before upgrading.`);
  const source = await readFile(resolve(sourceDirectory, 'dist/occt-import-js.js'), 'utf8');
  const output = resolve(root, 'public/vendor/occt');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'occt-import-js.mjs'), `${createCspCompatibleOcct(source)}\nexport default occtimportjs;\n`);
  await rm(resolve(output, 'occt-import-js.js'), { force: true });
  await copyFile(resolve(sourceDirectory, 'dist/occt-import-js.wasm'), resolve(output, 'occt-import-js.wasm'));
  await copyFile(resolve(sourceDirectory, 'LICENSE.md'), resolve(output, 'LICENSE.md'));
  await writeFile(resolve(output, 'NOTICE.txt'), `occt-import-js ${OCCT_VERSION}\nhttps://github.com/kovacsv/occt-import-js\nOriginal loader SHA-256: ${OCCT_GLUE_SHA256}\nThis distribution replaces generated embind wrapper builders with ordinary closures for Chrome MV3.\nThe patch and build instructions are included in the viewer source.\nPinned upstream package: https://registry.npmjs.org/occt-import-js/-/occt-import-js-${OCCT_VERSION}.tgz\nCAD import is local and uses no external conversion or AI service.\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareCadRuntime(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}

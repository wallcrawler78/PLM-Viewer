export const OCCT_VERSION: string;
export const OCCT_GLUE_SHA256: string;
export function createCspCompatibleOcct(source: string): string;
export function prepareCadRuntime(projectRoot: string): Promise<string>;

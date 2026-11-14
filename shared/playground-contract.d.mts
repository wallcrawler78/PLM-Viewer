export declare const ASSISTANT_LIMITS: Readonly<{ requestBytes: number; responseBytes: number; imageBytes: number; nodes: number; annotations: number; commands: number; timeoutMs: number }>;
export declare class PlaygroundError extends Error { code: string; constructor(code?: string); }
export declare const ASSISTANT_ERRORS: Readonly<Record<string, readonly [number, string]>>;
export declare function assistantFailure(error: unknown): { status: number; body: { code: string; error: string } };
export declare function validateAssistantRequest<T>(input: T): T;
export declare function validateAssistantPlan<T>(input: T, request: unknown): T;
export declare function stampAssistantConcepts<T>(plan: T, request: unknown): T;
export declare const ASSISTANT_PLAN_SCHEMA: Record<string, unknown>;

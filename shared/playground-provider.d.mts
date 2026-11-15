export interface AnthropicAssistant {
  provider: 'anthropic';
  model: string;
  propose(request: unknown, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  draftEcr(request: unknown, options?: { signal?: AbortSignal }): Promise<{ title: string; description: string; openQuestions: string[] }>;
}
export declare function abortable<T>(work: T | Promise<T>, signal?: AbortSignal): Promise<T>;
export declare function createAnthropicAssistant(options: { apiKey: string; model?: string; fetcher?: typeof fetch; directBrowser?: boolean }): AnthropicAssistant;

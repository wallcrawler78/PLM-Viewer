export interface AnthropicAssistant {
  provider: 'anthropic';
  model: string;
  propose(request: unknown, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
}
export declare function abortable<T>(work: T | Promise<T>, signal?: AbortSignal): Promise<T>;
export declare function createAnthropicAssistant(options: { apiKey: string; model?: string; fetcher?: typeof fetch; directBrowser?: boolean }): AnthropicAssistant;

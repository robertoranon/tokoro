// LLM provider abstraction

export type LLMMessageContent =
  | string  // Simple text content
  | LLMContentBlock[];  // Multimodal content (text + images)

export interface LLMTextBlock {
  type: 'text';
  text: string;
}

export interface LLMImageBlock {
  type: 'image';
  source: {
    type: 'url' | 'base64';
    url?: string;  // For URL-based images
    media_type?: string;  // For base64 images (e.g., "image/jpeg", "image/png")
    data?: string;  // Base64 encoded image data
  };
}

export type LLMContentBlock = LLMTextBlock | LLMImageBlock;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: LLMMessageContent;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMProvider {
  name: string;

  /**
   * Generate a completion from the LLM
   */
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json' | 'text';
}

export type LLMProviderType = 'ollama' | 'openai' | 'anthropic' | 'openrouter';

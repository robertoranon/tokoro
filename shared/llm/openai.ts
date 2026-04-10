import OpenAI from 'openai';
import {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  LLMMessageContent,
  LLMContentBlock,
} from '../types/llm';

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  get name(): string {
    return this.model;
  }

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: 60000,
      maxRetries: 2,
    });
    this.model = config.model || 'gpt-4o-mini';
  }

  private convertMessageContent(content: LLMMessageContent): string | OpenAI.ChatCompletionContentPart[] {
    if (typeof content === 'string') return content;
    return content.map((block: LLMContentBlock) => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image') {
        if (block.source.type === 'url') return { type: 'image_url', image_url: { url: block.source.url! } };
        return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
      }
      throw new Error(`Unknown content block type: ${(block as any).type}`);
    });
  }

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const params: OpenAI.ChatCompletionCreateParams = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: this.convertMessageContent(m.content),
      } as OpenAI.ChatCompletionMessageParam)),
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 2000,
    };
    if (options.responseFormat === 'json') params.response_format = { type: 'json_object' };
    const completion = await this.client.chat.completions.create(params);
    if (!('choices' in completion)) throw new Error('Unexpected streaming response from OpenAI');
    const choice = completion.choices[0];
    if (!choice?.message?.content) throw new Error('No content in OpenAI response');
    return {
      content: choice.message.content,
      model: completion.model,
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens,
      } : undefined,
    };
  }
}

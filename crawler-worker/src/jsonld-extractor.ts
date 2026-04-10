// Re-export shared JSON-LD extraction (uses regex parser by default, which works in Workers)
export { extractJsonLd, mergeJsonLdWithLlm, type JsonLdExtractionResult } from '../../shared/extractors/jsonld-extractor';

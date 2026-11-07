// M1 / E2: instruction decoding through Codama roots, with a built-in Anchor fallback.
export { createDecoder, type Decoder, type DecoderOptions } from "./decoder.js";
export * from "./builtin.js";
export { createAnchorFallbackDecoder, anchorInstructionDiscriminator, anchorSnakeCase, type AnchorFallbackDecoder, type AnchorDecoded } from "./anchor-fallback.js";
export * from "./types.js";

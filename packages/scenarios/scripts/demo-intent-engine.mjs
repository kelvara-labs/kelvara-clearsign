// Build-only adapter: keeps scenario runtime paths and CLI entry guards out of the engine bundle.
export { analyzeSession, ingestSession, createRpcAccountReader, validateIntentContext } from '../../core/src/index.ts';
export { loadRegistry } from '../../cli/src/registry.ts';

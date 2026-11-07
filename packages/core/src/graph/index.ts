// graph: authority maps, capability preview, capability diff (recovery paths). Ranking of granted
// and revoked capabilities under capability-risk-v1 happens in ReportBuilder.build.
export { buildAuthorityMap, classifyInstruction, describeInstruction, type AuthorityMap, type AuthorityMapEntry, type AuthorityTie, type AuthorityTieKind, type BuildAuthorityMapOptions } from "./authority-map.js";
export { addCapabilityPreviews, addRecoveryPaths, runCapabilityGraph, capabilityProgram, GRAPH_RULE_IDS, PREVIEW_RULE_ID, RECOVERY_RULE_ID, TOKEN_TAGS, type CapabilityGraphOptions } from "./preview.js";

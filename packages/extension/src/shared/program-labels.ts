// Program display names (E25) for programs ClearSign cannot decode. Names and ids only, from packages/idls/labels.json.
// A name never means the program is decoded, verified or safe.
import data from "../../../idls/labels.json";

interface LabelsFile { source: string; fetchedAt: string; labels: { programId: string; name: string }[] }
const file = data as LabelsFile;

export const LABELS_SOURCE = file.source;
export const LABEL_LIST: readonly { programId: string; name: string }[] = file.labels;
export const PROGRAM_LABELS: { source: string; names: Record<string, string> } = {
  source: file.source,
  names: Object.fromEntries(file.labels.map((l) => [l.programId, l.name]))
};

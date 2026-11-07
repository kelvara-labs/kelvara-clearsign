export type IngestErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "BAD_BASE64"
  | "MALFORMED"
  | "BAD_HEADER"
  | "BAD_INDEX"
  | "DUPLICATE_ACCOUNT"
  | "PROGRAM_FROM_LOOKUP"
  | "READER_FAILED";

/** Every failure in ingest is an IngestError. Anything else escaping ingest is a bug. */
export class IngestError extends Error {
  readonly code: IngestErrorCode;
  readonly transactionIndex: number | undefined;
  constructor(code: IngestErrorCode, message: string, transactionIndex?: number) {
    super(message);
    this.name = "IngestError";
    this.code = code;
    this.transactionIndex = transactionIndex;
  }
}

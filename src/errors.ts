/**
 * Error types. Tool handlers convert these into MCP `isError` results so a
 * failed call is a clean, readable message — never a crashed server.
 */

/** Base class for all expected, user-facing MemDrive failures. */
export class MemDriveError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'MemDriveError';
    this.code = code;
  }
}

/** Raised when a path would escape the configured library root. */
export class SandboxError extends MemDriveError {
  public constructor(message: string) {
    super('SANDBOX_VIOLATION', message);
    this.name = 'SandboxError';
  }
}

/** Raised when a requested file or directory does not exist. */
export class NotFoundError extends MemDriveError {
  public constructor(message: string) {
    super('NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** Raised when an image cannot be decoded, captured, or downloaded. */
export class ImageError extends MemDriveError {
  public constructor(message: string) {
    super('IMAGE_ERROR', message);
    this.name = 'ImageError';
  }
}

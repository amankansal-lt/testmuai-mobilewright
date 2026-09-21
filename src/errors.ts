export class WebDriverError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly error?: string,
  ) {
    super(message);
    this.name = 'WebDriverError';
  }

  /** The session is gone for good — retrying the command cannot help. */
  get isSessionGone(): boolean {
    return this.httpStatus === 404 || this.error === 'invalid session id';
  }
}

export class LambdaTestDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LambdaTestDriverError';
  }
}

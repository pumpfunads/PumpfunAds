/** An error whose message is safe to show the caller. */
export class ApiError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

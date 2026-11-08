import { HttpException, HttpStatus } from '@nestjs/common';

/** Error with a stable code and a plain-words message (see docs/api.md). */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string) {
    super({ code, message }, status);
  }
}
export const notAllowed = () => new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED', "You don't have permission to do this.");
export const notSignedIn = () => new AppError(HttpStatus.UNAUTHORIZED, 'NOT_SIGNED_IN', 'Please sign in again.');
export const badInput = (code: string, message: string) => new AppError(HttpStatus.BAD_REQUEST, code, message);
export const notFound = (what: string) => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message);

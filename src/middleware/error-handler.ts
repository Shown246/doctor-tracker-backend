import mongoose from 'mongoose';
import { ZodError } from 'zod';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError } from '../errors/api-error.js';
import type { Logger } from '../logging/logger.js';

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join('.') || 'body';
      (fields[key] ??= []).push('Invalid value');
    }
    return new ApiError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      fields,
    );
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const fields = Object.fromEntries(
      Object.keys(error.errors).map((key) => [key, ['Invalid value']]),
    );
    return new ApiError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      fields,
    );
  }
  if (error instanceof mongoose.Error.CastError) {
    return new ApiError(400, 'VALIDATION_ERROR', 'Invalid identifier or value');
  }
  if (error instanceof mongoose.Error.StrictModeError) {
    return new ApiError(400, 'VALIDATION_ERROR', 'Unknown or immutable field');
  }
  if (error instanceof mongoose.Error.VersionError) {
    return new ApiError(409, 'REVISION_CONFLICT', 'The record has changed');
  }
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && error.code === 11000) {
      return new ApiError(
        409,
        'DUPLICATE_KEY',
        'A unique value is already in use',
      );
    }
    if ('type' in error) {
      if (error.type === 'entity.too.large') {
        return new ApiError(
          413,
          'PAYLOAD_TOO_LARGE',
          'Request body is too large',
        );
      }
      if (error.type === 'entity.parse.failed') {
        return new ApiError(
          400,
          'MALFORMED_JSON',
          'Request body must be valid JSON',
        );
      }
      if (
        error.type === 'encoding.unsupported' ||
        error.type === 'charset.unsupported'
      ) {
        return new ApiError(
          415,
          'UNSUPPORTED_ENCODING',
          'Unsupported request encoding',
        );
      }
    }
  }
  if (error instanceof URIError) {
    return new ApiError(400, 'MALFORMED_REQUEST', 'Malformed request URL');
  }
  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new ApiError(404, 'NOT_FOUND', 'Route not found'));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const normalized = normalizeError(error);
    const requestId = response.locals.requestId as string;
    // Driver errors can contain credentials or submitted values. Log stable metadata only.
    const metadata = {
      requestId,
      code: normalized.code,
      status: normalized.status,
    };
    if (normalized.status >= 500) logger.error(metadata, 'Request failed');
    else logger.warn(metadata, 'Request rejected');
    response.status(normalized.status).json({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.fieldErrors
          ? { fieldErrors: normalized.fieldErrors }
          : {}),
        requestId,
      },
    });
  };
}

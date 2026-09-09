import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/http.ts';
import { env } from '../env.ts';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Endpoint not found.' });
}

/** Single JSON error shape: `{ error, field? }`. The client toasts `error`. */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, field: error.field });
    return;
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than the ${Math.round(env.uploadMaxBytes / (1024 * 1024))}MB limit.`
        : `Upload failed: ${error.message}`;
    res.status(400).json({ error: message });
    return;
  }

  console.error('[error]', error);
  res.status(500).json({
    error: env.isProd ? 'Something went wrong. Please try again.' : String((error as Error)?.message ?? error),
  });
}

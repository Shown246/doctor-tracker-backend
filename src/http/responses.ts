import type { Response } from 'express';

export function sendData<T>(response: Response, data: T, status = 200) {
  return response.status(status).json({ data });
}

export function sendList<T>(
  response: Response,
  data: T[],
  pagination: { page: number; limit: number; total: number },
) {
  return response.json({
    data,
    meta: {
      ...pagination,
      totalPages: Math.ceil(pagination.total / pagination.limit),
    },
  });
}

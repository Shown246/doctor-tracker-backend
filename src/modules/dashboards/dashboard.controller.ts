import type { RequestHandler } from 'express';
import { sendData } from '../../http/responses.js';
import { dashboardQuerySchema } from './dashboard.schemas.js';
import { dashboard } from './dashboard.service.js';
import { filterQuerySchema } from './filter.schemas.js';
import { filterOptions } from './filter.service.js';

export const getDashboard: RequestHandler = async (request, response) => {
  sendData(
    response,
    await dashboard(
      request.account!,
      dashboardQuerySchema.parse(request.query),
    ),
  );
};
export const getFilters: RequestHandler = async (request, response) => {
  response.json(
    await filterOptions(
      request.account!,
      filterQuerySchema.parse(request.query),
    ),
  );
};

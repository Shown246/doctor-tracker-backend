import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { Doctor } from '../modules/doctors/doctor.model.js';
import { Patient } from '../modules/patients/patient.model.js';
import { DoctorPatient } from '../modules/assignments/doctor-patient.model.js';
import { patientListPlan } from '../modules/patients/patient.service.js';
import { patientQuerySchema } from '../modules/patients/patient.schemas.js';
import { listFilter, listQuerySchema } from '../http/list-query.js';
import { filterPipeline } from '../modules/dashboards/filter.service.js';
import { filterQuerySchema } from '../modules/dashboards/filter.schemas.js';
import {
  topDoctorsPipeline,
  trendPipeline,
} from '../modules/dashboards/dashboard.service.js';
import { dashboardRange } from '../modules/dashboards/dashboard.time.js';
import { fixtureId } from './fixtures.js';

type Metrics = {
  indexes: string[];
  stages: string[];
  cursorDocumentsExamined: number;
  lookupDocumentsExamined: number;
  keysExamined: number;
  executionTimeMillis: number;
  returned: number;
};
export function summarizeExplain(explain: unknown): Metrics {
  const indexes = new Set<string>();
  const stages = new Set<string>();
  const metrics: Metrics = {
    indexes: [],
    stages: [],
    cursorDocumentsExamined: 0,
    lookupDocumentsExamined: 0,
    keysExamined: 0,
    executionTimeMillis: 0,
    returned: 0,
  };
  function visit(value: unknown, key = '') {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    const record = value as Record<string, unknown>;
    // Rejected plans are alternatives, not evidence of the chosen access path.
    for (const [name, item] of Object.entries(record)) {
      if (
        [
          'rejectedPlans',
          'allPlansExecution',
          'command',
          'serverInfo',
        ].includes(name)
      )
        continue;
      if (name === 'indexName' && typeof item === 'string') indexes.add(item);
      if (name === 'indexesUsed' && Array.isArray(item))
        item.forEach((index) => {
          if (typeof index === 'string') indexes.add(index);
        });
      if (name === 'stage' && typeof item === 'string') stages.add(item);
      if (
        name === 'executionTimeMillis' ||
        name === 'executionTimeMillisEstimate'
      )
        metrics.executionTimeMillis = Math.max(
          metrics.executionTimeMillis,
          Number(item) || 0,
        );
      visit(item, name);
    }
    if (key === 'executionStats') {
      metrics.cursorDocumentsExamined += Number(record.totalDocsExamined) || 0;
      metrics.keysExamined += Number(record.totalKeysExamined) || 0;
    }
    if ('$lookup' in record) {
      metrics.lookupDocumentsExamined += Number(record.totalDocsExamined) || 0;
      metrics.keysExamined += Number(record.totalKeysExamined) || 0;
    }
  }
  visit(explain);
  const root = explain as {
    executionStats?: { nReturned?: number };
    stages?: { nReturned?: number }[];
  };
  metrics.returned =
    root.executionStats?.nReturned ?? root.stages?.at(-1)?.nReturned ?? 0;
  return {
    ...metrics,
    indexes: [...indexes].sort(),
    stages: [...stages].sort(),
  };
}
export async function collectQueryPlans() {
  const doctorId = fixtureId('perf:doctor:1');
  const patientId = fixtureId('perf:patient:1');
  const range = dashboardRange({ from: '2026-10-01', to: '2026-10-31' })!;
  const plans: {
    name: string;
    query: string;
    wallTimeMillis: number;
    metrics: Metrics;
  }[] = [];
  async function measure(
    name: string,
    query: string,
    execute: () => Promise<unknown>,
  ) {
    const start = performance.now();
    const explain = await execute();
    plans.push({
      name,
      query,
      wallTimeMillis: Math.round((performance.now() - start) * 100) / 100,
      metrics: summarizeExplain(explain),
    });
  }
  await measure(
    'doctor prefix search',
    'search=synthetic doctor 00009; newest first; limit=20',
    async () =>
      Doctor.find(
        listFilter(listQuerySchema.parse({ search: 'synthetic doctor 00009' })),
      )
        .sort({ createdAt: -1, _id: -1 })
        .limit(20)
        .explain('executionStats'),
  );
  await measure(
    'doctor exact filters',
    'specialization=cardiology;hospital=Synthetic Hospital 1;newest first;limit=20',
    async () =>
      Doctor.find({
        specializationKey: 'cardiology',
        hospitalKey: 'synthetic hospital 1',
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(20)
        .explain('executionStats'),
  );
  await measure(
    'patient prefix search',
    'search=synthetic patient 00099; newest first; limit=20',
    async () =>
      Patient.find(
        listFilter(
          listQuerySchema.parse({ search: 'synthetic patient 00099' }),
        ),
      )
        .sort({ createdAt: -1, _id: -1 })
        .limit(20)
        .explain('executionStats'),
  );
  for (const [name, raw] of [
    [
      'combined exact filters',
      { condition: 'Synthetic Condition 1', status: 'under_treatment' },
    ],
    [
      'combined prefix and exact filters',
      {
        search: 'synthetic patient 0009',
        condition: 'Synthetic Condition 1',
        status: 'under_treatment',
      },
    ],
    ['large page offset', { page: '500' }],
  ] as const)
    await measure(name, JSON.stringify(raw), async () =>
      Patient.aggregate(
        patientListPlan(patientQuerySchema.parse(raw)).pipeline,
      ).explain('executionStats'),
    );
  await measure(
    'doctor-scoped patient page',
    'session doctor 1; page=1;limit=20;sort=-createdAt; includes count',
    async () =>
      DoctorPatient.aggregate(
        patientListPlan(patientQuerySchema.parse({}), doctorId.toString())
          .pipeline,
      ).explain('executionStats'),
  );
  await measure(
    'assignment pair',
    'doctor 1 / patient 1; exact pair',
    async () =>
      DoctorPatient.findOne({ doctorId, patientId }).explain('executionStats'),
  );
  await measure(
    'recent doctor assignments',
    'doctor 1; sort=-assignedAt,-_id; limit=10',
    async () =>
      DoctorPatient.find({ doctorId })
        .select('patientId assignedAt')
        .sort({ assignedAt: -1, _id: -1 })
        .limit(10)
        .explain('executionStats'),
  );
  await measure(
    'scoped filter metadata',
    'doctor 1; field=condition; page=1;limit=20',
    async () =>
      DoctorPatient.aggregate(
        filterPipeline(filterQuerySchema.parse({}), doctorId.toString()),
      ).explain('executionStats'),
  );
  await measure(
    'patient creation trend',
    '2026-10-01 through 2026-10-31; daily Asia/Dhaka',
    async () =>
      Patient.aggregate(trendPipeline('createdAt', range)).explain(
        'executionStats',
      ),
  );
  await measure(
    'doctor assignment trend',
    'doctor 1;2026-10-01 through 2026-10-31;daily Asia/Dhaka',
    async () =>
      DoctorPatient.aggregate([
        { $match: { doctorId } },
        ...trendPipeline('assignedAt', range),
      ]).explain('executionStats'),
  );
  await measure(
    'patient status distribution',
    'all stored patients; group by status',
    async () =>
      Patient.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).explain('executionStats'),
  );
  await measure(
    'top ten doctors',
    'current assignment counts; zero-patient doctors included; count desc/id asc; limit=10',
    async () =>
      Doctor.aggregate(topDoctorsPipeline)
        .allowDiskUse(true)
        .explain('executionStats'),
  );
  const countChecks = [];
  for (const raw of [
    {},
    { page: '500' },
    { condition: 'Synthetic Condition 1', status: 'under_treatment' },
    {
      search: 'synthetic patient 0009',
      condition: 'Synthetic Condition 1',
      status: 'under_treatment',
    },
    { page: '501' },
  ]) {
    const query = patientQuerySchema.parse(raw);
    const plan = patientListPlan(query);
    const [result] = await plan.model.aggregate<{
      records: { _id: unknown }[];
      count: { total: number }[];
    }>(plan.pipeline);
    const filter = {
      ...listFilter(query),
      ...(query.condition
        ? { conditionKey: query.condition.toLowerCase() }
        : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const expectedTotal = await Patient.countDocuments(filter);
    const actualTotal = result?.count[0]?.total ?? 0;
    const expectedLength = Math.max(
      0,
      Math.min(query.limit, expectedTotal - (query.page - 1) * query.limit),
    );
    const passed =
      actualTotal === expectedTotal &&
      result?.records.length === expectedLength;
    if (!passed) throw new Error('Performance count consistency failed');
    countChecks.push({
      query: raw,
      total: actualTotal,
      returned: result.records.length,
      passed,
    });
  }
  for (const page of ['1', '5', '6']) {
    const plan = patientListPlan(
      patientQuerySchema.parse({ page }),
      doctorId.toString(),
    );
    const [result] = await plan.model.aggregate<{
      records: { _id: unknown }[];
      count: { total: number }[];
    }>(plan.pipeline);
    const expected = await DoctorPatient.countDocuments({ doctorId });
    const actual = result?.count[0]?.total ?? 0;
    const length = Math.max(
      0,
      Math.min(20, expected - (Number(page) - 1) * 20),
    );
    if (actual !== expected || result?.records.length !== length)
      throw new Error('Scoped performance count consistency failed');
    countChecks.push({
      query: { page, doctorScope: 'synthetic doctor 1' },
      total: actual,
      returned: result.records.length,
      passed: true,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.versions.node,
      mongoose: mongoose.version,
      mongodb: (await mongoose.connection.db!.admin().serverInfo())
        .version as string,
    },
    dataset: {
      doctors: await Doctor.countDocuments({}),
      patients: await Patient.countDocuments({}),
      assignments: await DoctorPatient.countDocuments({}),
    },
    plans,
    countChecks,
  };
}

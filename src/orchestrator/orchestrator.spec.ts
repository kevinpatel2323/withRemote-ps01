import { OrchestratorService } from './orchestrator.service';
import { SYNC_QUEUE } from '../queue/pgboss.service';
import { SourceConnector } from '../connectors/connector.interface';

describe('OrchestratorService.dispatch', () => {
  it('enqueues one job per connector with a per-source singletonKey', async () => {
    const send = jest.fn().mockResolvedValue('job-id');
    const pgboss = { boss: { send, work: jest.fn() } } as any;
    const connectors = [
      { source: 'stripe' },
      { source: 'google_calendar' },
    ] as unknown as SourceConnector[];

    const orch = new OrchestratorService(pgboss, connectors, {} as any);
    const ids = await orch.dispatch('scheduled');

    expect(ids).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      SYNC_QUEUE,
      expect.objectContaining({ source: 'stripe', trigger: 'scheduled' }),
      expect.objectContaining({ singletonKey: 'stripe' }),
    );
    expect(send).toHaveBeenCalledWith(
      SYNC_QUEUE,
      expect.objectContaining({ source: 'google_calendar' }),
      expect.objectContaining({ singletonKey: 'google_calendar' }),
    );
  });

  it('registers a single-batch worker on init', async () => {
    const work = jest.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorService({ boss: { work } } as any, [] as any, {} as any);
    await orch.onModuleInit();
    expect(work).toHaveBeenCalledWith(SYNC_QUEUE, { batchSize: 1 }, expect.any(Function));
  });
});

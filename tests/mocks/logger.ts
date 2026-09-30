import { mock } from 'node:test';
import type { ActivityLogger, ActivityEvent } from '../../src/types/state';

export const logger: ActivityLogger =  {
    record: mock.fn<(event: ActivityEvent) => void>(),
};

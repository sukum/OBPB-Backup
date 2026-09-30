import { PocketBaseClient } from './pocketbase-client';
import { parsePocketBaseHealth } from './pocketbase-response-parsers';
import type { ConnectivityChecker } from '../queue/connectivity-monitor';

/**
 * ConnectivityChecker backed by the PocketBase health endpoint.
 */
export class PocketBaseHealthChecker implements ConnectivityChecker {
    constructor(private client: PocketBaseClient) {}

    /**
     * Used for connectivity checks
     * When an upload fails, this is ran and if it fails, it is kept running in an interval
     */
    public async healthCheck(): Promise<void> {
        const res = await this.client.request({
            method: 'GET',
            path: '/api/health',
        }, parsePocketBaseHealth);
        console.log('Health check response:', res);
        if (!res || res.code !== 200) {
            throw new Error('Health check failed');
        }
    }
}

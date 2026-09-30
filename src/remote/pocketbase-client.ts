import { requestUrl, RequestUrlParam } from 'obsidian';

export class PocketBaseError extends Error {
    constructor(
        public readonly status: number,
        public readonly responseText: string,
        public readonly data?: unknown
    ) {
        super(`PocketBase HTTP ${status}: ${responseText}`);
        this.name = 'PocketBaseError';
    }
}

export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
}

export type ResponseDecoder<T> = (value: unknown) => T;

/**
 * PocketBase REST client wrapping Obsidian's native requestUrl().
 */
export class PocketBaseClient {
    private token: string | null = null;

    constructor(private getBaseUrl: () => string) {}

    public setToken(token: string | null): void {
        this.token = token;
    }

    public getToken(): string | null {
        return this.token;
    }

    public async request(options: RequestOptions): Promise<unknown>;
    public async request<T>(options: RequestOptions, decode: ResponseDecoder<T>): Promise<T>;
    public async request<T>(options: RequestOptions, decode?: ResponseDecoder<T>): Promise<unknown> {
        const baseUrl = this.getBaseUrl().replace(/\/+$/, '');
        if (!baseUrl) {
            throw new Error('PocketBase server URL is not configured.');
        }

        let fullUrl = `${baseUrl}${options.path.startsWith('/') ? '' : '/'}${options.path}`;

        if (options.query) {
            const searchParams = new URLSearchParams();
            for (const [key, value] of Object.entries(options.query)) {
                if (value !== undefined) {
                    searchParams.append(key, String(value));
                }
            }
            const qs = searchParams.toString();
            if (qs) {
                fullUrl += `?${qs}`;
            }
        }

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            ...(options.headers || {}),
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        let bodyPayload: string | undefined;
        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            bodyPayload = JSON.stringify(options.body);
        }

        const param: RequestUrlParam = {
            url: fullUrl,
            method: options.method || 'GET',
            headers,
            body: bodyPayload,
            throw: false, // Handle HTTP statuses manually
        };

        const res = await requestUrl(param);

        if (res.status >= 400) {
            let errorData: unknown;
            try {
                errorData = res.json;
            } catch {
                // Ignore json parse error
                errorData = res.text;
            }
            throw new PocketBaseError(res.status, res.text, errorData);
        }

        const response: unknown = res.status === 204 ? undefined : res.json;
        return decode ? decode(response) : response;
    }
}

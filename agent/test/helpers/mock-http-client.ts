/**
 * Mock HTTP Client for Testing
 * =============================
 * 
 * Provides a controllable HTTP client for testing sync-state
 * without hitting real network endpoints.
 */

import { stub, SinonStub } from 'sinon';
import type { HttpClient, HttpResponse } from '../../src/lib/http-client';

export class MockHttpClient implements HttpClient {
	public getStub: SinonStub;
	public postStub: SinonStub;
	public patchStub: SinonStub;
	private postCallIndex: number = 0;
	private patchCallIndex: number = 0;
	
	constructor() {
		this.getStub = stub();
		this.postStub = stub();
		this.patchStub = stub();
	}
	
	async get<T = any>(url: string, options?: {
		headers?: Record<string, string>;
		timeout?: number;
	}): Promise<HttpResponse<T>> {
		return this.getStub(url, options);
	}
	
	async post<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
	}): Promise<HttpResponse<T>> {
		return this.postStub(url, body, options);
	}
	
	async patch<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: any) => void;
	}): Promise<HttpResponse<T>> {
		return this.patchStub(url, body, options);
	}
	
	/**
	 * Helper: Configure successful GET response
	 */
	mockGetSuccess<T>(body: T, options?: {
		status?: number;
		etag?: string;
	}): void {
		this.getStub.resolves({
			ok: true,
			status: options?.status || 200,
			statusText: 'OK',
			headers: {
				get: (name: string) => {
					if (name.toLowerCase() === 'etag' && options?.etag) {
						return options.etag;
					}
					return null;
				}
			},
			json: async () => body
		});
	}
	
	/**
	 * Helper: Configure successful POST response
	 * If called multiple times, queues responses in order (first call, second call, etc.)
	 */
	mockPostSuccess<T>(body: T, options?: {
		status?: number;
	}): void {
		this.postStub.onCall(this.postCallIndex++).resolves({
			ok: true,
			status: options?.status || 200,
			statusText: 'OK',
			headers: {
				get: () => null
			},
			json: async () => body
		});
	}
	
	/**
	 * Helper: Configure successful PATCH response
	 * If called multiple times, queues responses in order (first call, second call, etc.)
	 */
	mockPatchSuccess<T>(body: T, options?: {
		status?: number;
	}): void {
		this.patchStub.onCall(this.patchCallIndex++).resolves({
			ok: true,
			status: options?.status || 200,
			statusText: 'OK',
			headers: {
				get: () => null
			},
			json: async () => body
		});
	}
	
	/**
	 * Helper: Configure 304 Not Modified response
	 */
	mockGetNotModified(): void {
		this.getStub.resolves({
			ok: false,
			status: 304,
			statusText: 'Not Modified',
			headers: {
				get: () => null
			},
			json: async () => ({})
		});
	}
	
	/**
	 * Helper: Configure GET error response
	 */
	mockGetError(status: number, statusText: string): void {
		this.getStub.resolves({
			ok: false,
			status,
			statusText,
			headers: {
				get: () => null
			},
			json: async () => ({ error: statusText })
		});
	}
	
	/**
	 * Helper: Configure POST error response
	 */
	mockPostError(status: number, statusText: string): void {
		this.postStub.resolves({
			ok: false,
			status,
			statusText,
			headers: {
				get: () => null
			},
			json: async () => ({ error: statusText })
		});
	}
	
	/**
	 * Helper: Configure PATCH error response
	 */
	mockPatchError(status: number, statusText: string): void {
		this.patchStub.resolves({
			ok: false,
			status,
			statusText,
			headers: {
				get: () => null
			},
			json: async () => ({ error: statusText })
		});
	}
	
	/**
	 * Helper: Configure network error
	 */
	mockNetworkError(message: string = 'Network request failed'): void {
		this.getStub.rejects(new Error(message));
	}
	
	/**
	 * Helper: Configure timeout error
	 */
	mockTimeout(): void {
		const error = new Error('The operation was aborted');
		error.name = 'AbortError';
		this.getStub.rejects(error);
	}
	
	/**
	 * Reset all stubs
	 */
	reset(): void {
		this.getStub.reset();
		this.postStub.reset();
		this.patchStub.reset();
		this.postCallIndex = 0;
		this.patchCallIndex = 0;
	}
}

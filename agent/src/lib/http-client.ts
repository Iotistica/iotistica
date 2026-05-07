/**
 * HTTP Client Interface for API Binder
 * =====================================
 * 
 * Abstraction layer over fetch() to make sync-state testable.
 * Allows easy mocking in tests without stubbing global fetch.
 * 
 * Supports HTTPS with custom CA certificates for self-signed certs.
 */

import { Agent, fetch } from 'undici';
import type { Response } from 'undici';

/**
 * HTTP Error thrown when response status indicates failure (4xx, 5xx)
 */
export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly statusText: string,
		public readonly url: string,
		public readonly body?: any
	) {
		super(`HTTP ${status} ${statusText}: ${url}`);
		this.name = 'HttpError';
	}
}

export interface HttpResponse<T = any> {
	ok: boolean;
	status: number;
	statusText: string;
	headers: {
		get(name: string): string | null;
	};
	json(): Promise<T>;
}

export interface HttpClientOptions {
	/** Custom CA certificate for HTTPS (PEM format) */
	caCert?: string;
	/** Whether to reject unauthorized certificates (default: true) */
	rejectUnauthorized?: boolean;
	/** Default headers to include in all requests */
	defaultHeaders?: Record<string, string>;
	/** Default timeout for all requests in milliseconds */
	defaultTimeout?: number;
	/** Whether to throw HttpError on non-2xx responses (default: false) */
	throwOnHttpError?: boolean;
}

export interface CompressionStats {
	uncompressedBytes: number;
	compressedBytes: number;
	compressionRatio: number; // Percentage (0-100)
	savings: number; // Bytes saved
}

export interface HttpClient {
	/**
	* Make HTTP GET request
	*/
	get<T = any>(url: string, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		signal?: AbortSignal;
	}): Promise<HttpResponse<T>>;
	
	/**
	* Make HTTP POST request
	*/
	post<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<HttpResponse<T>>;
	
	/**
	* Make HTTP PATCH request
	*/
	patch<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<HttpResponse<T>>;
}

/**
 * Create HTTP client with appropriate TLS configuration based on endpoint
 * 
 * Centralized factory for all HTTP client creation to ensure consistent behavior:
 * - HTTPS endpoints: Accept self-signed certificates (rejectUnauthorized: false)
 * - HTTP endpoints: No TLS configuration needed
 * 
 * @param endpoint - API endpoint URL (e.g., "https://api.example.com:443")
 * @param options - Additional HTTP client options (timeout, headers, etc.)
 * @returns Configured HttpClient instance
 */
export function createHttpClient(
	endpoint: string,
	options?: {
		defaultTimeout?: number;
		defaultHeaders?: Record<string, string>;
		caCert?: string; // Optional CA certificate (PEM format)
	}
): HttpClient {
	const isHttps = endpoint.startsWith('https://');
	
	// For HTTPS endpoints without CA cert, disable certificate verification
	// This supports self-signed certificates across all environments
	const clientOptions: HttpClientOptions = {
		defaultTimeout: options?.defaultTimeout || 30000,
		defaultHeaders: options?.defaultHeaders,
	};

	if (options?.caCert) {
		// Use provided CA certificate
		clientOptions.caCert = options.caCert;
		clientOptions.rejectUnauthorized = true;
	} else if (isHttps) {
		// HTTPS without CA cert - accept self-signed certificates
		clientOptions.rejectUnauthorized = false;
	}

	return new FetchHttpClient(clientOptions);
}

/**
 * FetchHttpClient - HTTP client implementation using undici (fetch)
 */
export class FetchHttpClient implements HttpClient {
	private dispatcher?: Agent;
	private defaultHeaders: Record<string, string>;
	private defaultTimeout?: number;
	private throwOnHttpError: boolean;

	constructor(options?: HttpClientOptions) {
		this.defaultHeaders = options?.defaultHeaders || {};
		this.defaultTimeout = options?.defaultTimeout;
		this.throwOnHttpError = options?.throwOnHttpError ?? false;
		
		// Create undici dispatcher with TLS options (per-client, not global)
		// Agent is created once and reused for connection pooling + keep-alive
		if (options?.caCert || options?.rejectUnauthorized === false) {
			this.dispatcher = new Agent({
				connections: 100, // Max concurrent connections per origin
				pipelining: 10, // Max pipelined requests per connection
				keepAliveTimeout: 10000, // 10s HTTP keep-alive timeout
				keepAliveMaxTimeout: 600000, // Max keep-alive timeout (10min)
				connect: {
					ca: options.caCert,
					rejectUnauthorized: options.rejectUnauthorized ?? true,
				}
			});
			
		}
	}

	private combineSignals(signal1?: AbortSignal, signal2?: AbortSignal): AbortSignal | undefined {
		if (!signal1 && !signal2) return undefined;
		if (!signal1) return signal2;
		if (!signal2) return signal1;
		// Both signals present — combine so either abort cancels the request
		if (typeof AbortSignal.any === 'function') {
			return AbortSignal.any([signal1, signal2]);
		}
		// Fallback for runtimes without AbortSignal.any: prefer the external signal
		return signal1;
	}

	/**
	* Create AbortSignal with timeout
	* undici supports AbortSignal natively
	*/
	private createAbortSignal(timeoutMs?: number): AbortSignal | undefined {
		if (!timeoutMs) return undefined;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), timeoutMs);
		return controller.signal;
	}

	/**
	* Unified HTTP request method
	* Handles GET, POST, PATCH with optional body compression
	*/
	private async request<T = any>(
		method: 'GET' | 'POST' | 'PATCH',
		url: string,
		body?: any,
		options?: {
			headers?: Record<string, string>;
			timeout?: number;
			signal?: AbortSignal;
			compress?: boolean;
			onCompressionStats?: (stats: CompressionStats) => void;
		}
	): Promise<HttpResponse<T>> {
		const timeout = options?.timeout ?? this.defaultTimeout;
		let finalBody: Buffer | string | undefined;
		let finalHeaders: Record<string, string>;

		// Prepare body for POST/PATCH requests
		if (method !== 'GET' && body !== undefined) {
			const prepared = await this.prepareBody(body, options);
			finalBody = prepared.finalBody;
			finalHeaders = prepared.finalHeaders;
		} else {
			finalHeaders = { ...this.defaultHeaders, ...options?.headers };
		}

		const response = await fetch(url, {
			method,
			headers: finalHeaders,
			body: finalBody,
			signal: this.combineSignals(options?.signal, this.createAbortSignal(timeout)),
			dispatcher: this.dispatcher,
		});

		return this.checkResponse<T>(response, url);
	}

	async get<T = any>(url: string, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		signal?: AbortSignal;
	}): Promise<HttpResponse<T>> {
		return this.request<T>('GET', url, undefined, options);
	}

	async post<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<HttpResponse<T>> {
		return this.request<T>('POST', url, body, options);
	}

	async patch<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<HttpResponse<T>> {
		return this.request<T>('PATCH', url, body, options);
	}

	/**
	* Prepare request body with optional compression
	* Centralized logic for POST and PATCH methods
	* 
	* Compression strategy:
	* - Skip if < 1KB (overhead exceeds savings)
	* - Use Brotli for >= 10KB (better ratio)
	* - Use gzip for 1KB-10KB (faster)
	*/
	private async prepareBody(body: any, options?: {
		headers?: Record<string, string>;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<{ finalBody: Buffer | string; finalHeaders: Record<string, string> }> {
		let finalBody: Buffer | string;
		const finalHeaders = { ...this.defaultHeaders, ...options?.headers };
		
		// Convert objects to JSON string
		const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
		
		// Set Content-Type for JSON bodies (unless already set)
		if (typeof body !== 'string' && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
			finalHeaders['Content-Type'] = 'application/json';
		}
		
		const uncompressedBytes = Buffer.byteLength(bodyString, 'utf8');
		
		// Handle compression if requested and payload is large enough
		if (options?.compress && uncompressedBytes >= 1024) {
			const { gzip } = await import('zlib');
			const { promisify } = await import('util');
			
			// Always use gzip (Envoy Gateway doesn't properly handle Brotli Content-Encoding)
			const gzipAsync = promisify(gzip);
			const compressed = await gzipAsync(bodyString);
			const encoding = 'gzip';
			const compressedBytes = compressed.length;
			
			// Calculate compression stats
			const savings = uncompressedBytes - compressedBytes;
			const compressionRatio = uncompressedBytes > 0 
				? ((1 - compressedBytes / uncompressedBytes) * 100)
				: 0;
			
			// Call stats callback if provided
			if (options.onCompressionStats) {
				options.onCompressionStats({
					uncompressedBytes,
					compressedBytes,
					compressionRatio,
					savings
				});
			}
			
			finalBody = compressed;
			finalHeaders['Content-Encoding'] = encoding;
			finalHeaders['Content-Length'] = compressed.length.toString();
		} else {
			finalBody = bodyString;
		}
		
		return { finalBody, finalHeaders };
	}

	/**
	* Check response status and throw HttpError if configured
	*/
	private async checkResponse<T>(response: Response, url: string): Promise<HttpResponse<T>> {
		const httpResponse: HttpResponse<T> = {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			headers: {
				get: (name: string) => response.headers.get(name)
			},
			json: () => response.json() as Promise<T>
		};

		if (this.throwOnHttpError && !response.ok) {
			let body: any;
			try {
				body = await response.json();
			} catch {
				// Ignore JSON parse errors
			}
			throw new HttpError(response.status, response.statusText, url, body);
		}

		return httpResponse;
	}
}

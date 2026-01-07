/**
 * HTTP Client Interface for API Binder
 * =====================================
 * 
 * Abstraction layer over fetch() to make sync-state testable.
 * Allows easy mocking in tests without stubbing global fetch.
 * 
 * Supports HTTPS with custom CA certificates for self-signed certs.
 */

import { Agent } from 'undici';

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
 * Default implementation using native fetch with HTTPS support
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
				keepAliveTimeout: 4000, // Keep-alive timeout (ms)
				keepAliveMaxTimeout: 600000, // Max keep-alive timeout (10min)
				connect: {
					ca: options.caCert,
					rejectUnauthorized: options.rejectUnauthorized ?? true,
				}
			});
			
			console.log('[HttpClient] Created undici dispatcher with TLS options:', {
				rejectUnauthorized: options.rejectUnauthorized ?? true,
				hasCaCert: !!options.caCert
			});
		}
	}

	/**
	 * Create AbortSignal with timeout (Node.js 18+ compatible with polyfill)
	 * Feature detection for older runtimes that don't support AbortSignal.timeout()
	 */
	private createAbortSignal(timeoutMs?: number): AbortSignal | undefined {
		if (!timeoutMs) return undefined;
		// Use native AbortSignal.timeout if available (Node ≥18)
		if (typeof (AbortSignal as any).timeout === 'function') {
			return (AbortSignal as any).timeout(timeoutMs);
		}
		// Fallback for older Node.js versions
		const controller = new AbortController();
		setTimeout(() => controller.abort(), timeoutMs);
		return controller.signal;
	}

	async get<T = any>(url: string, options?: {
		headers?: Record<string, string>;
		timeout?: number;
	}): Promise<HttpResponse<T>> {
		const timeout = options?.timeout ?? this.defaultTimeout;
		const response = await fetch(url, {
			method: 'GET',
			headers: { ...this.defaultHeaders, ...options?.headers },
			signal: this.createAbortSignal(timeout),
			// @ts-ignore - TypeScript doesn't recognize dispatcher option yet
			dispatcher: this.dispatcher,
		});
		
		return this.checkResponse<T>(response, url);
	}
	
	async post<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<HttpResponse<T>> {
		const { finalBody, finalHeaders } = await this.prepareBody(body, options);
		
		const timeout = options?.timeout ?? this.defaultTimeout;
		const response = await fetch(url, {
			method: 'POST',
			headers: finalHeaders,
			body: finalBody,
			signal: this.createAbortSignal(timeout),
			// @ts-ignore - TypeScript doesn't recognize dispatcher option yet
			dispatcher: this.dispatcher,
		});
		
		return this.checkResponse<T>(response, url);
	}
	
	async patch<T = any>(url: string, body: any, options?: {
		headers?: Record<string, string>;
		timeout?: number;
		compress?: boolean;
		onCompressionStats?: (stats: CompressionStats) => void;
	}): Promise<HttpResponse<T>> {
		const { finalBody, finalHeaders } = await this.prepareBody(body, options);
		
		const timeout = options?.timeout ?? this.defaultTimeout;
		const response = await fetch(url, {
			method: 'PATCH',
			headers: finalHeaders,
			body: finalBody,
			signal: this.createAbortSignal(timeout),
			// @ts-ignore - TypeScript doesn't recognize dispatcher option yet
			dispatcher: this.dispatcher,
		});
		
		return this.checkResponse<T>(response, url);
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
			const { brotliCompress, gzip } = await import('zlib');
			const { promisify } = await import('util');
			
			let compressed: Buffer;
			let encoding: string;
			
			// Use Brotli for large payloads (better compression ratio)
			if (uncompressedBytes >= 10 * 1024) {
				const brotliAsync = promisify(brotliCompress);
				compressed = await brotliAsync(bodyString);
				encoding = 'br';
			} else {
				// Use gzip for medium payloads (faster)
				const gzipAsync = promisify(gzip);
				compressed = await gzipAsync(bodyString);
				encoding = 'gzip';
			}
			
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

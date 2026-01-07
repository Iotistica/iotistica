/**
 * HTTP Client Interface for API Binder
 * =====================================
 * 
 * Abstraction layer over fetch() to make sync-state testable.
 * Allows easy mocking in tests without stubbing global fetch.
 * 
 * Supports HTTPS with custom CA certificates for self-signed certs.
 */

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
	private caCert?: string;
	private rejectUnauthorized: boolean;
	private defaultHeaders: Record<string, string>;
	private defaultTimeout?: number;

	constructor(options?: HttpClientOptions) {
		this.caCert = options?.caCert;
		// Default to true unless explicitly set to false
		this.rejectUnauthorized = options?.rejectUnauthorized ?? true;
		this.defaultHeaders = options?.defaultHeaders || {};
		this.defaultTimeout = options?.defaultTimeout;
		
		// Log constructor options for debugging
		console.log('[HttpClient] Constructor called with options:', {
			optionsRejectUnauthorized: options?.rejectUnauthorized,
			thisRejectUnauthorized: this.rejectUnauthorized,
			hasCaCert: !!options?.caCert
		});
		
		// For localhost development with self-signed certs, we need to disable TLS verification
		// Node.js fetch (undici) doesn't support per-request TLS options well
		if (this.rejectUnauthorized === false) {
			console.log('[HttpClient] Setting NODE_TLS_REJECT_UNAUTHORIZED=0 for self-signed HTTPS');
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		}
	}

	async get<T = any>(url: string, options?: {
		headers?: Record<string, string>;
		timeout?: number;
	}): Promise<HttpResponse<T>> {
		const httpsAgent = this.isHttps(url) ? this.getHttpsAgent() : {};
		
		// Debug logging
		if (this.isHttps(url)) {
			console.log('[HttpClient] Making HTTPS request:', {
				url,
				hasAgent: !!(httpsAgent as any).agent,
				rejectUnauthorized: this.rejectUnauthorized
			});
		}
		
		const timeout = options?.timeout ?? this.defaultTimeout;
		const response = await fetch(url, {
			method: 'GET',
			headers: { ...this.defaultHeaders, ...options?.headers },
			signal: timeout ? AbortSignal.timeout(timeout) : undefined,
			// @ts-ignore - Node.js fetch supports agent option
			...httpsAgent,
		});
		
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			headers: {
				get: (name: string) => response.headers.get(name)
			},
			json: () => response.json() as Promise<T>
		};
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
			signal: timeout ? AbortSignal.timeout(timeout) : undefined,
			// @ts-ignore - Node.js fetch supports agent option
			...(this.isHttps(url) ? this.getHttpsAgent() : {}),
		});
		
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			headers: {
				get: (name: string) => response.headers.get(name)
			},
			json: () => response.json() as Promise<T>
		};
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
			signal: timeout ? AbortSignal.timeout(timeout) : undefined,
			// @ts-ignore - Node.js fetch supports agent option
			...(this.isHttps(url) ? this.getHttpsAgent() : {}),
		});
		
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			headers: {
				get: (name: string) => response.headers.get(name)
			},
			json: () => response.json() as Promise<T>
		};
	}

	/**
	 * Prepare request body with optional compression
	 * Centralized logic for POST and PATCH methods
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
		
		// Handle compression if requested
		if (options?.compress) {
			const { gzip } = await import('zlib');
			const { promisify } = await import('util');
			const gzipAsync = promisify(gzip);
			
			const uncompressedBytes = Buffer.byteLength(bodyString, 'utf8');
			const compressed = await gzipAsync(bodyString);
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
			finalHeaders['Content-Encoding'] = 'gzip';
		} else {
			finalBody = bodyString;
		}
		
		return { finalBody, finalHeaders };
	}

	private isHttps(url: string): boolean {
		return url.startsWith('https://');
	}

	private getHttpsAgent() {
		// Debug logging
		console.log('[HttpClient] Creating HTTPS agent:', {
			hasCaCert: !!this.caCert,
			rejectUnauthorized: this.rejectUnauthorized
		});
		
		// Node.js fetch uses undici internally but doesn't expose it
		// The agent option doesn't work reliably with fetch()
		// We've already set NODE_TLS_REJECT_UNAUTHORIZED in constructor if needed
		const https = require('https');
		const agent = new https.Agent({
			ca: this.caCert,
			rejectUnauthorized: this.rejectUnauthorized,
		});
		
		return { agent };
	}
}

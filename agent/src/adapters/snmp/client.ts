// agent/src/features/endpoints/snmp/client.ts
import * as snmp from 'net-snmp';
import { type SNMPDeviceConfig } from './types.js';
import type { Logger } from '../types.js';

export class SNMPClient {
	private session?: any; // Use any to avoid type issues with net-snmp
	private config: SNMPDeviceConfig;
	private logger: Logger;
	private connected = false;

	constructor(config: SNMPDeviceConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	async connect(): Promise<void> {
		const options: any = {
			port: this.config.connection.port || 161,
			version: this.mapVersion(this.config.connection.version),
			timeout: this.config.connection.timeout || 5000,
			retries: this.config.connection.retries || 1,
		};

		if (this.config.connection.version === 'v3') {
			// SNMPv3 with authentication
			options.user = {
				name: this.config.connection.username!,
				level: this.mapSecurityLevel(this.config.connection.securityLevel),
				authProtocol: this.mapAuthProtocol(this.config.connection.authProtocol),
				authKey: this.config.connection.authKey,
				privProtocol: this.mapPrivProtocol(this.config.connection.privProtocol),
				privKey: this.config.connection.privKey,
			};
			this.session = snmp.createV3Session(this.config.connection.host, options.user, options);
		} else {
			// SNMPv1/v2c with community string
			const community = this.config.connection.community || 'public';
			this.session = snmp.createSession(
				this.config.connection.host,
				community,
				options
			);
		}

		this.connected = true;
		this.logger.debug(`SNMP session created for ${this.config.name}`);
	}

	async disconnect(): Promise<void> {
		if (this.session) {
			this.session.close();
			this.session = undefined;
			this.connected = false;
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	async get(oid: string): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.session) {
				return reject(new Error('SNMP session not initialized'));
			}

			this.session.get([oid], (error: Error | null, varbinds: any[]) => {
				if (error) {
					return reject(error);
				}

				if (!varbinds || varbinds.length === 0) {
					return reject(new Error(`No data for OID: ${oid}`));
				}

				const varbind = varbinds[0];
				if (snmp.isVarbindError(varbind)) {
					return reject(new Error(snmp.varbindError(varbind)));
				}

				resolve(varbind.value);
			});
		});
	}

	async getBulk(oids: string[], maxRepetitions = 10): Promise<Map<string, any>> {
		return new Promise((resolve, reject) => {
			if (!this.session) {
				return reject(new Error('SNMP session not initialized'));
			}

			this.session.getBulk(oids, 0, maxRepetitions, (error: Error | null, varbinds: any[]) => {
				if (error) {
					return reject(error);
				}

				const results = new Map<string, any>();
				if (varbinds && Array.isArray(varbinds)) {
					for (const varbind of varbinds) {
						if (!snmp.isVarbindError(varbind)) {
							results.set(varbind.oid, varbind.value);
						}
					}
				}

				resolve(results);
			});
		});
	}

	private mapVersion(version: string): number {
		switch (version) {
			case 'v1': return snmp.Version1;
			case 'v2c': return snmp.Version2c;
			case 'v3': return snmp.Version3;
			default: return snmp.Version2c;
		}
	}

	private mapSecurityLevel(level?: string): number {
		switch (level) {
			case 'noAuthNoPriv': return snmp.SecurityLevel.noAuthNoPriv;
			case 'authNoPriv': return snmp.SecurityLevel.authNoPriv;
			case 'authPriv': return snmp.SecurityLevel.authPriv;
			case undefined: return snmp.SecurityLevel.noAuthNoPriv;
			default: return snmp.SecurityLevel.noAuthNoPriv;
		}
	}

	private mapAuthProtocol(protocol?: string): any {
		switch (protocol) {
			case 'md5': return snmp.AuthProtocols.md5;
			case 'sha': return snmp.AuthProtocols.sha;
			case undefined: return snmp.AuthProtocols.md5;
			default: return snmp.AuthProtocols.md5;
		}
	}

	private mapPrivProtocol(protocol?: string): any {
		switch (protocol) {
			case 'des': return snmp.PrivProtocols.des;
			case 'aes': return snmp.PrivProtocols.aes;
			case undefined: return snmp.PrivProtocols.des;
			default: return snmp.PrivProtocols.des;
		}
	}
}

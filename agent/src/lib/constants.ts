/**
 * Constants
 */

const agentNetworkInterface = 'agent0';

const constants = {
	agentNetworkInterface: agentNetworkInterface,
	agentNetworkSubnet: '10.114.104.0/25',
	agentNetworkGateway: '10.114.104.1',

	defaultVolumeLabels: {
		'iotistic.managed': 'true',
		// Volume versioning for future migrations (schema changes, data layout changes)
		// When version mismatch detected: trigger migration container, upgrade safely
		'iotistic.volume-version': '1',
	},
};

export = constants;

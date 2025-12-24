/**
 * Constants (simplified - no supervisor network for now)
 */

import path from 'path';
import { checkString } from './validation';


const supervisorNetworkInterface = 'supervisor0';

// /mnt/root is the legacy root mountpoint
const rootMountPoint = checkString(process.env.ROOT_MOUNTPOINT) || '/mnt/root';
const withRootMount = (p: string) => path.join(rootMountPoint, p);
const bootMountPoint = checkString(process.env.BOOT_MOUNTPOINT) || '/mnt/boot';
const stateMountPoint =
	checkString(process.env.STATE_MOUNTPOINT) || '/mnt/state';
const dataMountPoint = checkString(process.env.DATA_MOUNTPOINT) || '/mnt/data';

const constants = {
	// Root overlay paths
	rootMountPoint,
	vpnStatusPath:
		checkString(process.env.VPN_STATUS_PATH) ||
		withRootMount('/run/openvpn/vpn_status'),
	// Boot paths
	bootMountPoint,
	configJsonPath:
		checkString(process.env.CONFIG_MOUNT_POINT) ||
		path.join(bootMountPoint, 'config.json'),
	hostOSVersionPath:
		checkString(process.env.HOST_OS_VERSION_PATH) ||
		withRootMount('/etc/os-release'),
	// Data paths
	dataMountPoint,
	databasePath:
		checkString(process.env.DATABASE_PATH) || '/app/data/device.sqlite',
	appsJsonPath: path.join(dataMountPoint, 'apps.json'),
	migrationBackupFile: path.join(dataMountPoint, 'backup.tgz'),
	// State paths
	stateMountPoint,
	// Other constants: network, Engine, /sys
	containerId: checkString(process.env.SUPERVISOR_CONTAINER_ID) || undefined,
	dockerSocket: process.env.DOCKER_SOCKET || 
		(process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),
	// In-container location for docker socket
	// Mount in /host/run to avoid clashing with systemd
	containerDockerSocket: '/host/run/balena-engine.sock',
	supervisorImage:
		checkString(process.env.SUPERVISOR_IMAGE) || 'resin/rpi-supervisor',
	ledFile:
		checkString(process.env.LED_FILE) || '/sys/class/leds/led0/brightness',
	macAddressPath: checkString(process.env.MAC_ADDRESS_PATH) || `/sys/class/net`,
	privateAppEnvVars: [
		'RESIN_SUPERVISOR_API_KEY',
		'RESIN_API_KEY',
		'BALENA_SUPERVISOR_API_KEY',
		'BALENA_API_KEY',
	],
	supervisorNetworkInterface,
	allowedInterfaces: [
		'resin-vpn',
		'tun0',
		'docker0',
		'lo',
		supervisorNetworkInterface,
	],
	ipAddressUpdateInterval: 30 * 1000,
	imageCleanupErrorIgnoreTimeout: 3600 * 1000,
	maxDeltaDownloads: 3,

	bootBlockDevice: '/dev/mmcblk0p1',
	hostConfigVarPrefix: 'HOST_',
	// Use this failure multiplied by 2**Number of failures to increase
	// the backoff on subsequent failures
	backoffIncrement: 500,
	supervisorNetworkSubnet: '10.114.104.0/25',
	supervisorNetworkGateway: '10.114.104.1',
	// How much of a jitter we can add to our api polling
	// (this number is used as an upper bound when generating
	// a random jitter)
	maxApiJitterDelay: 60 * 1000,

	defaultVolumeLabels: {
		'iotistic.managed': 'true',
		// Volume versioning for future migrations (schema changes, data layout changes)
		// When version mismatch detected: trigger migration container, upgrade safely
		'iotistic.volume-version': '1',
	},
	
	// Current volume schema version
	// Increment when making breaking changes that require data migration
	currentVolumeVersion: 1,
}


if (process.env.DOCKER_HOST == null) {
	process.env.DOCKER_HOST = `unix://${constants.dockerSocket}`;
}

export = constants;

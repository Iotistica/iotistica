import { migration as squashedInitialSchema } from './migrations/20260312020000_squashed_initial_schema.js';
import { migration as seedEndpointOutputs } from './migrations/20260313000000_seed_endpoint_outputs.js';
import { migration as addAnomalyBaselineDeviceState } from './migrations/20260316000000_add_anomaly_baseline_device_state.js';
import { migration as addAnomalyBaselineDeviceId } from './migrations/20260316010000_add_anomaly_baseline_device_id.js';
import { migration as renameDeviceTableToAgent } from './migrations/20260317000000_rename_device_table_to_agent.js';
import { migration as renameAgentColumns } from './migrations/20260317010000_rename_agent_columns.js';
import { migration as dropAgentCloudId } from './migrations/20260317020000_drop_agent_cloudid.js';
import { migration as addDevicesTable } from './migrations/20260318000000_add_devices_table.js';
import type { NativeSqliteMigration } from './migration-types.js';

export const nativeMigrations: NativeSqliteMigration[] = [
	squashedInitialSchema,
	seedEndpointOutputs,
	addAnomalyBaselineDeviceState,
	addAnomalyBaselineDeviceId,
	renameDeviceTableToAgent,
	renameAgentColumns,
	dropAgentCloudId,
	addDevicesTable,
];
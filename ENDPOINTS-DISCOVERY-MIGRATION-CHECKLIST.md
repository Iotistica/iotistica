# Endpoints-Based Discovery Implementation Checklist

## Overview

Track progress of implementing `endpoints[]`-based discovery configuration.

**Total Estimated Time**: 3 weeks
**Team Size**: 2-3 developers
**Risk Level**: Low (development phase, no backward compatibility needed)

---

## Phase 1: Core Implementation (Week 1)

**Goal**: Agent reads ONLY from `endpoints[]` for discovery

### Week 1: Types, Configuration, and Discovery Plugins

- [ ] **1.1 Update TypeScript Types** (4 hours)
  - [ ] Add `DiscoveryConfig` interface to `agent/src/features/endpoints/types.ts`
  - [ ] Add `isDiscoveryTarget?: boolean` to `EndpointConfig`
  - [ ] Add `source?: 'manual' | 'discovered'` to `EndpointConfig`
  - [ ] Add `discoveryConfig?: DiscoveryConfig` to `EndpointConfig`
  - [ ] Update `ModbusConnection` to include `slaveRange?: { start: number; end: number }`
  - [ ] Write type tests to ensure backward compatibility

- [ ] **1.2 Add AgentConfig Methods** (6 hours)
  - [ ] Implement `getDiscoveryTargets(protocol: string): any[]` in `agent/src/config/agent-config.ts`
  - [ ] Implement `normalizeDiscoveryTarget(endpoint: any): any` helper
  - [ ] Filter for `isDiscoveryTarget === true` and `enabled !== false`
  - [ ] Write unit tests for endpoints-only reading
  - [ ] Write unit tests for protocol filtering
  - [ ] Write unit tests for enabled/disabled filtering

- [ ] **1.3 Update Discovery Service Base** (4 hours)
  - [ ] Update `agent/src/features/discovery/discovery-service.ts` to use `getDiscoveryTargets()`
  - [ ] Add logging for discovery targets found
  - [ ] Update discovery metadata to track source
  - [ ] Test with endpoints[] config

### Week 1: Update Protocol Discovery Plugins (Continued)

- [ ] **2.1 Update Modbus Discovery** (6 hours)
  - [ ] Replace `getModbusConfig()` with `getDiscoveryTargets('modbus')` in `modbus.discovery.ts`
  - [ ] Update connection iteration logic (lines 64-150)
  - [ ] Update logging to show discovery target names
  - [ ] Write integration tests
  - [ ] Test with real Modbus simulator

- [ ] **2.2 Update OPC-UA Discovery** (4 hours)
  - [ ] Replace config reading with `getDiscoveryTargets('opcua')` in `opcua.discovery.ts`
  - [ ] Update connection string normalization
  - [ ] Write integration tests

- [ ] **2.3 Update SNMP Discovery** (4 hours)
  - [ ] Replace config reading with `getDiscoveryTargets('snmp')` in `snmp.discovery.ts`
  - [ ] Update IP range parsing
  - [ ] Write integration tests

- [ ] **2.4 Update BACnet Discovery** (4 hours)
  - [ ] Replace config reading with `getDiscoveryTargets('bacnet')` in `bacnet.discovery.ts`
  - [ ] Update broadcast address handling
  - [ ] Write integration tests

- [ ] **2.5 Integration Testing** (8 hours)
  - [ ] Test with `endpoints[]` (new format)
  - [ ] Test with empty configs (no discovery)
  - [ ] Test boot discovery (first_boot trigger with validation)
  - [ ] Test scheduled discovery (scheduled trigger without validation)
  - [ ] Performance testing (ensure no regression)

- [ ] **2.6 Documentation** (4 hours)
  - [ ] Update agent README with new config format
  - [ ] Update configuration examples
  - [ ] Add discovery scheduling documentation
  - [ ] Add troubleshooting section

---

## Phase 2: Dashboard Integration (Week 2)

- [ ] **3.1 Update Sensor Schemas** (4 hours)
  - [ ] Add `DiscoveryTargetSchema` to `dashboard/src/schemas/sensor-schemas.ts`
  - [ ] Add `isDiscoveryTarget`, `source`, `discoveryConfig` fields
  - [ ] Add Zod validation for discovery-specific fields
  - [ ] Update `ModbusConnectionSchema` to support `slaveRange`
  - [ ] Write schema validation tests

- [ ] **3.2 Create Discovery Target Table** (8 hours)
  - [ ] Create `dashboard/src/components/sensors/DiscoveryTargetsTable.tsx`
  - [ ] Add columns: Name, Protocol, Target, Scan Interval, Status, Actions
  - [ ] Add Enable/Disable toggle
  - [ ] Add Edit/Delete actions
  - [ ] Add sorting and filtering
  - [ ] Add search functionality

- [ ] **3.3 Create Add Discovery Target Dialog** (12 hours)
  - [ ] Create `dashboard/src/components/sensors/AddDiscoveryTargetDialog.tsx`
  - [ ] Copy structure from `AddSensorDialog.tsx`
  - [ ] Create `ModbusDiscoveryForm.tsx` with:
    - [ ] Connection settings (host, port, timeout)
    - [ ] Slave range input (start, end)
    - [ ] Scan interval input (hours)
    - [ ] Validation toggle
    - [ ] Profile selector
  - [ ] Create `OPCUADiscoveryForm.tsx` with:
    - [ ] URL input
    - [ ] Scan interval
    - [ ] Validation toggle
  - [ ] Create `SNMPDiscoveryForm.tsx` with:
    - [ ] IP range input (CIDR notation)
    - [ ] Community string
    - [ ] SNMP version selector
  - [ ] Add form validation
  - [ ] Add save handler

- [ ] **3.4 Create Edit Discovery Target Dialog** (6 hours)
  - [ ] Create `dashboard/src/components/sensors/EditDiscoveryTargetDialog.tsx`
  - [ ] Pre-populate form with existing values
  - [ ] Use same forms as Add dialog
  - [ ] Handle updates via PUT endpoint

- [ ] **3.5 Update Sensors Page** (8 hours)
  - [ ] Add tabs to `dashboard/src/pages/SensorsPage.tsx`
  - [ ] Create "Devices" tab (existing table)
  - [ ] Create "Discovery Targets" tab (new table)
  - [ ] Filter sensors by `isDiscoveryTarget` flag
  - [ ] Add "Add Discovery Target" button
  - [ ] Wire up dialogs to API calls
  - [ ] Add migration banner for old format detection

### Week 4: API Endpoints and Testing

- [ ] **4.1 Create Discovery Target API Endpoints** (8 hours)
  - [ ] Add `POST /api/v1/devices/:uuid/discovery-targets` to `api/src/routes/device-sensors.ts`
  - [ ] Add `PUT /api/v1/devices/:uuid/discovery-targets/:name`
  - [ ] Add `DELETE /api/v1/devices/:uuid/discovery-targets/:name`
  - [ ] Implement `isDiscoveryTarget` flag setting
  - [ ] Implement dual-write to PostgreSQL and target_state JSON
  - [ ] Add validation for discovery-specific fields
  - [ ] Add audit logging with username

- [ ] **4.2 Update Device Sensor Sync Service** (4 hours)
  - [ ] Update `api/src/services/device-sensor-sync.service.ts`
  - [ ] Handle `isDiscoveryTarget` field
  - [ ] Handle `discoveryConfig` serialization
  - [ ] Ensure backward compatibility

- [ ] **4.3 E2E Testing** (12 hours)
  - [ ] Test creating Modbus discovery target
  - [ ] Test creating OPC-UA discovery target
  - [ ] Test editing discovery target
  - [ ] Test deleting discovery target
  - [ ] Test enabling/disabling discovery target
  - [ ] Test migration banner display
  - [ ] Test filtering (Devices vs Discovery Targets tabs)
  - [ ] Test form validation
  - [ ] Test API error handling

- [ ] **4.4 Dashboard Documentation** (4 hours)
  - [ ] Update dashboard README
  - [ ] Add screenshots of Discovery Targets UI
  - [ ] Add user guide for adding discovery targets
  - [ ] Document field meanings

---

## Phase 3: Cleanup (Week 3)

**Goal**: Remove `protocols{}` section entirely

### Week 3: Remove Legacy Code and Documentation

- [ ] **5.1 Create Migration Script** (12 hours)
  - [ ] Create `scripts/migrate-protocols-to-endpoints.ts`
  - [ ] Implement Modbus protocol conversion
  - [ ] Implement OPC-UA protocol conversion
  - [ ] Implement SNMP protocol conversion
  - [ ] Implement BACnet protocol conversion
  - [ ] Generate UUIDs for new endpoints
  - [ ] Set `isDiscoveryTarget: true` flag
  - [ ] Set `source: 'manual'` (since user configured protocols)
  - [ ] Preserve `protocols{}` section for backward compatibility
  - [ ] Add dry-run mode for preview
  - [ ] Add rollback function
  - [ ] Generate migration report (JSON)

- [ ] **5.2 Migration Script Testing** (8 hours)
  - [ ] Test with Modbus-only config
  - [ ] Test with multi-protocol config
  - [ ] Test with empty protocols
  - [ ] Test with complex connection arrays
  - [ ] Test dry-run mode
  - [ ] Test rollback
  - [ ] Test idempotency (run twice)

- [ ] **5.3 Migration UI (Optional)** (8 hours)
  - [ ] Add migration banner to dashboard (if `protocols{}` detected)
  - [ ] Add "Migrate Now" button
  - [ ] Show migration preview dialog
  - [ ] Show migration progress
  - [ ] Show migration report (success/failures)
  - [ ] Add rollback button

- [ ] **5.4 Migration Documentation** (4 hours)
  - [ ] Write migration guide for users
  - [ ] Document CLI usage (`npm run migrate-protocols`)
  - [ ] Document dashboard migration flow
  - [ ] Add FAQs
  - [ ] Add troubleshooting section
  - [ ] Add rollback instructions

---

## Phase 4: Deprecation and Cleanup (Week 6+)

**Goal**: Mark `protocols{}` as deprecated, monitor adoption

### Week 6: Deprecation Warnings and Monitoring

- [ ] **6.1 Enhanced Deprecation Warnings** (4 hours)
  - [ ] Add startup warning if `protocols{}` used
  - [ ] Add periodic reminders (weekly logs)
  - [ ] Add dashboard deprecation banner
  - [ ] Add API response headers (`X-Config-Deprecated: protocols`)

- [ ] **6.2 Metrics and Monitoring** (6 hours)
  - [ ] Track % of devices using `protocols{}` vs `endpoints[]`
  - [ ] Track migration completion rate
  - [ ] Track discovery success rate (ensure no regression)
  - [ ] Add Grafana dashboard for migration metrics
  - [ ] Set up alerts for config format issues

- [ ] **6.3 Update Documentation** (4 hours)
  - [ ] Mark `protocols{}` as DEPRECATED in all docs
  - [ ] Update all examples to use `endpoints[]`
  - [ ] Add migration deadline notice
  - [ ] Update API documentation

### Future: Complete Removal (v2.0.0)

- [ ] **7.1 Remove protocols{} Support** (8 hours)
  - [ ] Remove `protocols{}` reading from `AgentConfig`
  - [ ] Remove fallback logic in discovery plugins
  - [ ] Remove deprecation warnings (no longer needed)
  - [ ] Update TypeScript types
  - [ ] Remove unused code paths

- [ ] **7.2 Database Cleanup** (4 hours)
  - [ ] Script to remove `protocols{}` section from all target_state JSONs
  - [ ] Verify all devices migrated
  - [ ] Archive old format for reference

---

## Cross-Cutting Tasks

### Testing Strategy

- [ ] **Unit Tests** (Throughout all phases)
  - [ ] AgentConfig dual-source reading
  - [ ] Discovery target normalization
  - [ ] Protocol-specific discovery logic
  - [ ] Dashboard form validation
  - [ ] API endpoint validation

- [ ] **Integration Tests**
  - [ ] Agent discovers devices with new config
  - [ ] Dashboard CRUD operations work
  - [ ] API dual-write to PostgreSQL + target_state
  - [ ] Migration script produces correct output

- [ ] **E2E Tests**
  - [ ] Complete workflow: Add discovery target → Agent scans → Device found → User enables
  - [ ] Migration workflow: Old config → Migrate → New config → Agent works
  - [ ] Rollback workflow: New config → Rollback → Old config → Agent works

### Documentation

- [ ] **User Documentation**
  - [ ] Configuration guide (new format)
  - [ ] Migration guide (step-by-step)
  - [ ] Dashboard user guide
  - [ ] API reference updates

- [ ] **Developer Documentation**
  - [ ] Architecture decision record (ADR)
  - [ ] Code comments
  - [ ] Type documentation
  - [ ] Migration plan (this document!)

### Deployment

- [ ] **Staging Deployment** (Before production)
  - [ ] Deploy agent v1.0.230 to staging
  - [ ] Deploy dashboard updates to staging
  - [ ] Deploy API updates to staging
  - [ ] Run full E2E test suite
  - [ ] Manual testing with real devices
  - [ ] Performance testing (ensure no regression)

- [ ] **Production Rollout** (Gradual)
  - [ ] Deploy to 10% of devices (canary)
  - [ ] Monitor for errors (24 hours)
  - [ ] Deploy to 50% of devices
  - [ ] Monitor for errors (48 hours)
  - [ ] Deploy to 100% of devices
  - [ ] Send migration notifications to users

---

## Risk Mitigation

### Identified Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Discovery stops working | Low | High | Dual-source support, extensive testing, gradual rollout |
| Performance degradation | Low | Medium | Performance tests, profiling, optimize if needed |
| Data loss during migration | Low | High | Keep `protocols{}`, migration is additive, rollback script |
| User confusion | Medium | Low | Clear documentation, migration banner, support articles |
| API breaking changes | Low | High | Backward compatible API, versioning if needed |

### Rollback Plan

If critical issues arise:

1. **Agent Rollback**: Deploy previous version (< 1.0.230)
2. **Dashboard Rollback**: Hide new UI, revert API calls
3. **Database Rollback**: `protocols{}` never deleted, safe to revert
4. **User Communication**: Notify via dashboard banner + email

---

## Success Metrics

### Phase 1 Success Criteria

- [ ] Agent can read discovery targets from `endpoints[]`
- [ ] Agent falls back to `protocols{}` if no `endpoints[]` targets
- [ ] All discovery plugins updated (Modbus, OPC-UA, SNMP, BACnet)
- [ ] Zero discovery failures in testing
- [ ] Deprecation warnings logged correctly

### Phase 2 Success Criteria

- [ ] Dashboard shows "Discovery Targets" tab
- [ ] Users can add/edit/delete discovery targets via UI
- [ ] API endpoints work correctly
- [ ] Form validation prevents invalid configs
- [ ] Migration banner shows when appropriate

### Phase 3 Success Criteria

- [ ] Migration script runs without errors
- [ ] Migrated configs work with agent
- [ ] Rollback script works
- [ ] Migration report is accurate

### Overall Success Metrics (After 3 months)

- [ ] **Migration Adoption**: > 80% of devices using `endpoints[]` format
- [ ] **Discovery Success Rate**: No regression (maintain current rate)
- [ ] **Performance**: Discovery time unchanged (< 5 min for 100 devices)
- [ ] **User Satisfaction**: < 5% support tickets related to migration
- [ ] **Zero Production Incidents**: No critical bugs related to migration

---

## Communication Plan

### Internal Communication

- [ ] **Kickoff Meeting** (Week 0)
  - [ ] Review migration plan
  - [ ] Assign tasks
  - [ ] Set milestones

- [ ] **Weekly Standups** (Weeks 1-6)
  - [ ] Progress updates
  - [ ] Blocker discussion
  - [ ] Risk assessment

- [ ] **Review Meetings** (End of each phase)
  - [ ] Demo functionality
  - [ ] Review metrics
  - [ ] Adjust timeline if needed

### User Communication

- [ ] **Pre-Migration** (Week 0)
  - [ ] Announcement email
  - [ ] Migration guide published
  - [ ] Dashboard banner with timeline

- [ ] **During Migration** (Weeks 1-6)
  - [ ] Dashboard banner with migration instructions
  - [ ] Support article updates
  - [ ] Webinar (optional)

- [ ] **Post-Migration** (Week 7+)
  - [ ] Success announcement
  - [ ] Deprecation timeline for `protocols{}`
  - [ ] Support for questions

---

## Timeline Summary

| Week | Phase | Key Deliverables | Team |
|------|-------|------------------|------|
| 1 | Phase 1 | Types, AgentConfig, Tests | Backend |
| 2 | Phase 1 | Discovery plugins, Integration tests | Backend |
| 3 | Phase 2 | Dashboard UI, Forms | Frontend |
| 4 | Phase 2 | API endpoints, E2E tests | Full Stack |
| 5 | Phase 3 | Migration script, Testing | Backend |
| 6+ | Phase 4 | Deprecation, Monitoring | DevOps |

---

## Next Actions (This Week)

1. [ ] **Review this checklist** with team
2. [ ] **Create GitHub project** with tasks from checklist
3. [ ] **Assign owners** to each phase
4. [ ] **Set up staging environment** for testing
5. [ ] **Create feature branch** (`feature/endpoints-discovery-migration`)
6. [ ] **Start Phase 1, Task 1.1** (Update TypeScript types)

---

## Resources

### Documentation References

- [Full Migration Plan](./docs/ENDPOINTS-DISCOVERY-MIGRATION-PLAN.md)
- [Quick Reference](./ENDPOINTS-DISCOVERY-MIGRATION-QUICK-REF.md)
- [Visual Flow](./docs/ENDPOINTS-DISCOVERY-MIGRATION-VISUAL.md)

### Code References

- `agent/src/config/agent-config.ts` - Configuration layer
- `agent/src/features/discovery/*.discovery.ts` - Discovery plugins
- `dashboard/src/pages/SensorsPage.tsx` - Sensors UI
- `api/src/routes/device-sensors.ts` - Sensor CRUD API

### External Resources

- [DevOps CALMS Principles](../.github/instructions/devops-core-principles.instructions.md)
- [React Best Practices](../.github/instructions/reactjs.instructions.md)

---

## Notes

- Keep `protocols{}` section throughout migration for backward compatibility
- Prioritize `endpoints[]` over `protocols{}` when both exist
- Add extensive logging for debugging migration issues
- Write comprehensive tests before touching production code
- Gradual rollout to minimize risk

---

**Last Updated**: 2025-01-21
**Document Owner**: Development Team
**Status**: ✅ Ready for Implementation

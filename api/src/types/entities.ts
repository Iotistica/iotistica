/**
 * Entity and Relationship Types for Digital Twin
 * 
 * These types define the structure for the entity-relationship graph
 * that powers the complete digital twin functionality.
 */

// ============================================================================
// Entity Types
// ============================================================================

export interface EntityType {
  id: number;
  name: string;
  display_name: string;
  icon?: string;
  properties_schema?: Record<string, any>;
  description?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Entity {
  id: string;
  entity_type: string;
  name: string;
  description?: string;
  metadata: Record<string, any>;
  agent_uuid?: string;
  created_at: Date;
  updated_at: Date;
}

export interface EntityProperty {
  id: string;
  entity_id: string;
  property_key: string;
  property_value: any;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Relationship Types
// ============================================================================

export interface EntityRelationship {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: RelationshipType;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export type RelationshipType =
  | 'CONTAINS'        // A contains B (building contains floor)
  | 'PART_OF'         // A is part of B (inverse of CONTAINS)
  | 'DEPENDS_ON'      // A depends on B (device depends on gateway)
  | 'MONITORS'        // A monitors B (sensor monitors equipment)
  | 'CONTROLS'        // A controls B (controller controls HVAC)
  | 'CONNECTED_TO'    // A is connected to B (network connection)
  | 'CORRELATED_WITH' // A is statistically correlated with B
  | 'LOCATED_IN';     // A is located in B (device in room)

// ============================================================================
// Graph Query Types
// ============================================================================

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties?: Record<string, any>;
  agent_uuid?: string;
  status?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: RelationshipType;
  metadata?: Record<string, any>;
}

export interface GraphTopology {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface HierarchyNode extends Entity {
  children?: HierarchyNode[];
  depth: number;
  parent_id?: string;
}

export interface ImpactAnalysis {
  entity: Entity;
  impacted: Array<{
    entity: Entity;
    relationship_path: string[];
    severity: 'critical' | 'high' | 'medium' | 'low';
  }>;
  affected_count: number;
}

// ============================================================================
// Request/Response DTOs
// ============================================================================

export interface CreateEntityRequest {
  entity_type: string;
  name: string;
  description?: string;
  metadata?: Record<string, any>;
  agent_uuid?: string;
}

export interface UpdateEntityRequest {
  name?: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface CreateRelationshipRequest {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: RelationshipType;
  metadata?: Record<string, any>;
}

export interface EntityWithRelationships extends Entity {
  relationships: {
    outgoing: EntityRelationship[];
    incoming: EntityRelationship[];
  };
}

export interface EntityTreeResponse {
  root: Entity;
  tree: HierarchyNode;
  total_descendants: number;
  max_depth: number;
}

// ============================================================================
// Query Filters
// ============================================================================

export interface EntityFilter {
  entity_type?: string;
  name?: string;
  agent_uuid?: string;
  metadata?: Record<string, any>;
  limit?: number;
  offset?: number;
}

export interface RelationshipFilter {
  source_entity_id?: string;
  target_entity_id?: string;
  relationship_type?: RelationshipType;
  direction?: 'outgoing' | 'incoming' | 'both';
}

// ============================================================================
// Aggregate Types (for enhanced digital twin queries)
// ============================================================================

export interface EntityAggregateMetrics {
  entity: Entity;
  device_count: number;
  online_agents: number;
  offline_agents: number;
  avg_metrics?: {
    temperature?: number;
    humidity?: number;
    cpu_usage?: number;
    memory_usage?: number;
  };
  health_score?: number;
}

export interface FloorStatus extends EntityAggregateMetrics {
  rooms: EntityAggregateMetrics[];
}

export interface BuildingStatus extends EntityAggregateMetrics {
  floors: FloorStatus[];
}

// ============================================================================
// Path Finding
// ============================================================================

export interface EntityPath {
  from: Entity;
  to: Entity;
  path: Array<{
    entity: Entity;
    relationship: EntityRelationship;
  }>;
  length: number;
}

// ============================================================================
// View Types (from database views)
// ============================================================================

export interface EntityHierarchyView {
  id: string;
  entity_type: string;
  name: string;
  agent_uuid?: string;
  parent_id?: string;
  depth: number;
  path: string[];
}

export interface DeviceLocationView {
  entity_id: string;
  device_name: string;
  agent_uuid: string;
  shadow_uuid?: string;
  reported_state?: any;
  building_name?: string;
  floor_name?: string;
  room_name?: string;
}

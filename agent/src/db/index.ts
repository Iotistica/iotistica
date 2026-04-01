/**
 * Database Module
 * ===============
 * 
 * Exports database initialization/shutdown helpers and client interface.
 * Runtime CRUD should use direct SQLite helpers or model files instead of connection helpers.
 */

// Re-export connection lifecycle helpers (migrations, init/shutdown, database path)
export * from './connection';

// Re-export database client interface (for device-manager abstraction)
export * from './client';

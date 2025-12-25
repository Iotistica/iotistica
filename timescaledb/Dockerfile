# TimescaleDB with CloudNativePG Kubernetes Operator
# Multi-stage build for TimescaleDB extension on PostgreSQL base
# Note: Vector search extensions (pgvector, pgvectorscale) are NOT included

# ==============================================================================
# Stage 1: Install TimescaleDB from APT Repository
# ==============================================================================
FROM postgres:17-bookworm AS timescaledb-builder

ARG PG_MAJOR=17
ARG TIMESCALEDB_VERSION=2

# Install TimescaleDB from official repository
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /etc/apt/keyrings/timescaledb.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ bookworm main" > /etc/apt/sources.list.d/timescaledb.list \
    && apt-get update \
    && apt-get install -y \
        timescaledb-${TIMESCALEDB_VERSION}-postgresql-${PG_MAJOR} \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ==============================================================================
# Stage 2: Assemble Runtime Image
# ==============================================================================
FROM postgres:17-bookworm

ARG PG_MAJOR=17

# Copy TimescaleDB shared libraries and SQL/control files
# CloudNativePG requires strict adherence to standard PostgreSQL paths
COPY --from=timescaledb-builder \
    /usr/lib/postgresql/${PG_MAJOR}/lib/timescaledb*.so \
    /usr/lib/postgresql/${PG_MAJOR}/lib/

COPY --from=timescaledb-builder \
    /usr/share/postgresql/${PG_MAJOR}/extension/timescaledb*.sql \
    /usr/share/postgresql/${PG_MAJOR}/extension/

COPY --from=timescaledb-builder \
    /usr/share/postgresql/${PG_MAJOR}/extension/timescaledb.control \
    /usr/share/postgresql/${PG_MAJOR}/extension/

# Metadata labels
LABEL org.opencontainers.image.title="TimescaleDB for CloudNativePG"
LABEL org.opencontainers.image.description="PostgreSQL 17 with TimescaleDB extension, optimized for CloudNativePG operator"
LABEL org.opencontainers.image.source="https://github.com/Iotistica/iotistic"
LABEL com.iotistic.postgresql.version="17"
LABEL com.iotistic.timescaledb.version="2.x"

# Switch to postgres user (UID 26) - CloudNativePG requirement
USER 26

# =============================================================================
# Dockerfile for TimescaleDB + CloudNativePG
# Installs TimescaleDB extension for PostgreSQL 17 on CloudNativePG base image
# TimescaleDB version is determined by the apt package manager
# =============================================================================

ARG PG_MAJOR=17

# Build TimescaleDB extension
# Installs TimescaleDB extension via apt package manager
FROM ghcr.io/cloudnative-pg/postgresql:${PG_MAJOR}-bookworm AS timescaledb-builder

ARG PG_MAJOR

USER root

# Add Timescale package repository
RUN apt-get update && apt-get install -y --no-install-recommends \
   ca-certificates gnupg lsb-release curl && rm -rf /var/lib/apt/lists/*

RUN echo "deb https://packagecloud.io/timescale/timescaledb/debian/ $(lsb_release -cs) main" > /etc/apt/sources.list.d/timescaledb.list && \
   curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg

# Add PGDG repository for PostgreSQL dependencies
RUN echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
   curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg

# Install TimescaleDB extension package for the target PostgreSQL version
RUN apt-get update && apt-get install -y --no-install-recommends \
   timescaledb-2-postgresql-${PG_MAJOR} \
   && rm -rf /var/lib/apt/lists/*

# Final image assembly
FROM ghcr.io/cloudnative-pg/postgresql:${PG_MAJOR}-bookworm

ARG PG_MAJOR

USER root

# Copy TimescaleDB extension artifacts from builder stage
COPY --from=timescaledb-builder \
   /usr/lib/postgresql/${PG_MAJOR}/lib/timescaledb*.so \
   /usr/lib/postgresql/${PG_MAJOR}/lib/
COPY --from=timescaledb-builder \
   /usr/share/postgresql/${PG_MAJOR}/extension/timescaledb*.sql \
   /usr/share/postgresql/${PG_MAJOR}/extension/
COPY --from=timescaledb-builder \
   /usr/share/postgresql/${PG_MAJOR}/extension/timescaledb.control \
   /usr/share/postgresql/${PG_MAJOR}/extension/

# Switch to CloudNativePG's unprivileged user (UID 26)
USER 26

LABEL org.opencontainers.image.title="CloudNativePG TimescaleDB"
LABEL org.opencontainers.image.description="PostgreSQL ${PG_MAJOR} with TimescaleDB extension for time-series workloads on Kubernetes"
LABEL org.opencontainers.image.source="https://github.com/Iotistica/iotistic"
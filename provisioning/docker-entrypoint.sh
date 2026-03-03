#!/bin/bash
# Docker Entrypoint - Run migrations before starting app
set -e

echo "🚀 Starting Billing Service..."

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL..."
until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${DB_USER:-billing}" > /dev/null 2>&1; do
  echo "   PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "✅ PostgreSQL is ready!"

# Determine if this is the API or Worker based on the command
# API: node dist/index.js
# Worker: node dist/worker.js
IS_WORKER=false
if [[ "$@" == *"dist/worker.js"* ]]; then
  IS_WORKER=true
fi

# Run migrations ONLY for the API container
if [ "$IS_WORKER" = false ]; then
  echo "📦 Running database migrations (API container)..."

  # Check if psql is available
  if command -v psql > /dev/null 2>&1; then
    # Run all migrations in order
    for migration in /app/migrations/*.sql; do
      if [ -f "$migration" ]; then
        migration_name=$(basename "$migration")
        echo "   Applying $migration_name..."
        
        # Run migration and capture output
        PGPASSWORD="${DB_PASSWORD}" psql \
          -h "${DB_HOST:-postgres}" \
          -p "${DB_PORT:-5432}" \
          -U "${DB_USER:-billing}" \
          -d "${DB_NAME:-billing}" \
          -f "$migration" \
          -v ON_ERROR_STOP=1 2>&1 | grep -v "NOTICE:" || true
        
        # Check exit status
        if [ ${PIPESTATUS[0]} -eq 0 ]; then
          echo "   ✓ Applied $migration_name"
        else
          echo "   ✗ Failed to apply $migration_name"
          echo "   ⚠️  Migration error detected - check connection settings"
          echo "   DB_HOST=${DB_HOST:-postgres}, DB_PORT=${DB_PORT:-5432}, DB_USER=${DB_USER:-billing}"
          exit 1
        fi
      fi
    done
    echo "✅ Migrations complete!"
  else
    echo "⚠️  psql not found, skipping migrations"
    echo "   Migrations should be run manually"
  fi

  # Create the API schema template database (if configured)
  # This is only done when DB_PROVIDER=postgres and PROVISIONING_PG_TEMPLATE_DB is set.
  # Admin credentials (PROVISIONING_PG_ADMIN_USER / PROVISIONING_PG_ADMIN_PASSWORD) are
  # required since CREATE DATABASE and ALTER DATABASE require superuser or owner privileges.
  if [ "${DB_PROVIDER}" = "postgres" ] && [ -n "${PROVISIONING_PG_TEMPLATE_DB}" ]; then
    echo ""
    echo "🗄️  Creating API schema template database: ${PROVISIONING_PG_TEMPLATE_DB}..."
    if node dist/scripts/create-template-db.js; then
      echo "✅ Template database ready"
    else
      echo "⚠️  Template database creation failed (non-fatal) – client databases will run migrations on first startup"
    fi
  fi
else
  echo "⏭️  Skipping migrations (Worker container - API runs migrations)"
fi

# Start the application
echo "🎉 Starting application..."
exec "$@"

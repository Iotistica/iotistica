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

# Run migrations
echo "📦 Running database migrations..."

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
else
  echo "⚠️  psql not found, skipping migrations"
  echo "   Migrations should be run manually"
fi

echo "✅ Migrations complete!"

# Start the application
echo "🎉 Starting application..."
exec "$@"

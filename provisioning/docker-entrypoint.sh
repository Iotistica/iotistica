#!/bin/sh
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
      echo "   Applying $(basename $migration)..."
      PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST:-postgres}" \
        -p "${DB_PORT:-5432}" \
        -U "${DB_USER:-billing}" \
        -d "${DB_NAME:-billing}" \
        -f "$migration" \
        -v ON_ERROR_STOP=1 \
        --quiet \
        2>&1 | grep -v "NOTICE: relation" || true
      echo "   ✓ Applied $(basename $migration)"
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

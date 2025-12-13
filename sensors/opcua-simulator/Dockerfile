FROM python:3.11-slim

WORKDIR /app

# Install build dependencies for ARM platforms (gcc required for cffi compilation)
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libffi-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN pip install --no-cache-dir asyncua==1.0.6

# Copy simulator script
COPY sensors/opcua-simulator/opcua_simulator.py .

# Expose OPC UA port
EXPOSE 4840

# Run simulator
CMD ["python", "-u", "opcua_simulator.py"]

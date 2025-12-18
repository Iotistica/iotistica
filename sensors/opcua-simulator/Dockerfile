FROM python:3.11-slim

WORKDIR /app

# Install build dependencies for ARM platforms
# gcc, g++, make: C/C++ compiler toolchain
# libffi-dev: Foreign Function Interface library headers
# python3-dev: Python development headers
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        make \
        libffi-dev \
        python3-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Upgrade pip and install dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir asyncua==1.0.6

# Copy simulator script (build context is sensors/opcua-simulator)
COPY opcua_simulator.py .

# Expose OPC UA port
EXPOSE 4840

# Run simulator
CMD ["python", "-u", "opcua_simulator.py"]

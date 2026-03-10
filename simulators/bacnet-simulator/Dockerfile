FROM python:3.11-slim

WORKDIR /app

# Install build dependencies for ARM platforms
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libffi-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install BACpypes3 library
RUN pip install --no-cache-dir bacpypes3==0.0.91

# Copy simulator script
COPY bacnet_simulator.py .

# Expose BACnet port (UDP 47808)
EXPOSE 47808/udp

# Run simulator
CMD ["python", "-u", "bacnet_simulator.py"]

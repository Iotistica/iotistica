FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir pymodbus==3.5.4

# Copy simulator script
COPY modbus_simulator.py .

# Copy vendor data points from shared config directory
COPY ../../config/vendors ./vendors

# Expose Modbus TCP port
EXPOSE 502

# Run simulator
CMD ["python", "-u", "modbus_simulator.py"]

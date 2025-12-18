FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir pymodbus==3.5.4

# Copy simulator script (build context is sensors/modbus-simulator)
COPY modbus_simulator.py .

# Expose Modbus TCP port
EXPOSE 502

# Run simulator
CMD ["python", "-u", "modbus_simulator.py"]

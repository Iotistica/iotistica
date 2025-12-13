FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir asyncua==1.0.6

# Copy simulator script
COPY sensors/opcua-simulator/opcua_simulator.py .

# Expose OPC UA port
EXPOSE 4840

# Run simulator
CMD ["python", "-u", "opcua_simulator.py"]

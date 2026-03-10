FROM python:3.11-slim

LABEL maintainer="Iotistic Platform"
LABEL description="COMAP Generator Controller Simulator"

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy simulator code
COPY *.py .

# Expose Modbus TCP port
EXPOSE 502

# Run simulator
CMD ["python", "-u", "comap_simulator.py"]

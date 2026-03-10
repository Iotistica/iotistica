FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir python-can==4.3.1

# Copy simulator script
COPY canbus_simulator.py .

# Expose CAN over TCP port
EXPOSE 11898

# Run simulator
CMD ["python", "-u", "canbus_simulator.py"]

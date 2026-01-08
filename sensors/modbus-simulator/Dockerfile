FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all files
COPY simulator.py .
COPY profile_loader.py .
COPY templates/ templates/
COPY static/ static/

# Expose Modbus TCP port and Web GUI port
EXPOSE 502 5000

# Run unified simulator (single process, no start.sh needed)
CMD ["python3", "simulator.py"]

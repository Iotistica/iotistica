FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all files
COPY modbus_simulator.py .
COPY web_gui.py .
COPY start.sh .
COPY templates/ templates/
COPY static/ static/

# Make start script executable
RUN chmod +x start.sh

# Expose Modbus TCP port and Web GUI port
EXPOSE 502 5000

# Run both services
CMD ["./start.sh"]

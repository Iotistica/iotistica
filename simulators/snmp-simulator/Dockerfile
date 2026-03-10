FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir pysnmp==4.4.12 pyasn1==0.5.1

# Copy simulator script
COPY snmp_simulator.py .

# Make script executable
RUN chmod +x snmp_simulator.py

# Expose SNMP port
EXPOSE 161/udp

# Run simulator
CMD ["python", "-u", "snmp_simulator.py"]

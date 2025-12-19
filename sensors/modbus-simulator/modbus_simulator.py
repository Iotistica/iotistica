#!/usr/bin/env python3
"""
Generic Modbus TCP Simulator
Supports multiple slave IDs with vendor-specific data points loaded from API or JSON.
Environment Variables:
- MODBUS_VENDOR: name of the vendor to simulate (default: 'Generic')
- MODBUS_API_URL: API URL to fetch vendor data (default: 'http://api:3002')
- MODBUS_VENDOR_JSON: fallback path to JSON file (default: './vendors/dataPoints.json')
- MODBUS_SLAVES: number of slave IDs to simulate (default: 3)
- MODBUS_PORT: TCP port to listen on (default: 502)
"""
import logging
import time
import random
import os
import json
import urllib.request
from pymodbus.server import StartTcpServer
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
VENDOR = os.environ.get("MODBUS_VENDOR", "Generic")
API_URL = os.environ.get("MODBUS_API_URL", "http://api:3002")
JSON_FILE = os.environ.get("MODBUS_VENDOR_JSON", "./vendors/dataPoints.json")

# Load vendor data from API or fallback to file
def load_vendor_data():
    """Load vendor data points from API, fallback to local file"""
    # Try API first (with retries)
    max_retries = 3
    retry_delay = 2  # seconds
    
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/vendors/datapoints?protocol=modbus"
            logger.info(f"Fetching vendor data from API: {url} (attempt {attempt + 1}/{max_retries})")
            
            req = urllib.request.Request(url, headers={'User-Agent': 'modbus-simulator/1.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                vendor_data = json.loads(response.read().decode())
                logger.info(f"✓ Loaded vendor data from API ({len(vendor_data)} vendors)")
                return vendor_data
        except Exception as e:
            if attempt < max_retries - 1:
                logger.warning(f"API attempt {attempt + 1} failed: {e}, retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                logger.warning(f"Failed to load from API after {max_retries} attempts: {e}")
    
    # Fallback to file
    try:
        logger.info(f"Falling back to local file: {JSON_FILE}")
        with open(JSON_FILE, "r") as f:
            vendor_data = json.load(f)
            logger.info(f"✓ Loaded vendor data from file ({len(vendor_data)} vendors)")
            return vendor_data
    except Exception as e:
        logger.error(f"Failed to load vendor data from file '{JSON_FILE}': {e}")
        return {}

vendor_data = load_vendor_data()
DATA_POINTS = vendor_data.get(VENDOR, {}).get("dataPoints", [])

class VendorDataBlock(ModbusSequentialDataBlock):
    """Simulate Modbus registers for any vendor"""
    def __init__(self, address, values, is_coil=False):
        super().__init__(address, values)
        self.start_time = time.time()
        self.is_coil = is_coil

    def getValues(self, address, count=1):
        elapsed = time.time() - self.start_time
        values = []

        for i in range(count):
            addr = address + i

            if self.is_coil:
                # Alarms / digital signals (random True/False)
                values.append(bool(random.random() < 0.05))
                continue

            # Look up data point in JSON by address
            dp = next((dp for dp in DATA_POINTS if dp["address"] == addr), None)
            if dp:
                base = dp.get("base", 100)  # default base if not specified
                noise_pct = dp.get("noise_pct", 0.05)
                val = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
                values.append(val)
                continue

            # Default placeholder for unspecified addresses
            values.append(0)

        return values

def setup_server(slaves=3):
    """Setup Modbus TCP server simulating vendor devices"""
    slave_contexts = {}
    identities = {}

    for unit_id in range(1, slaves + 1):
        hr = VendorDataBlock(1, [0]*200)
        ir = VendorDataBlock(1, [0]*100)
        co = VendorDataBlock(1, [False]*20, is_coil=True)
        di = VendorDataBlock(1, [False]*20, is_coil=True)

        store = ModbusSlaveContext(hr=hr, ir=ir, co=co, di=di)
        slave_contexts[unit_id] = store

        identity = ModbusDeviceIdentification()
        identity.VendorName = VENDOR
        identity.ProductCode = f"{VENDOR}-{unit_id}"
        identity.VendorUrl = vendor_data.get(VENDOR, {}).get("vendorUrl", "")
        identity.ProductName = f"{VENDOR} Modbus Simulator"
        identity.ModelName = vendor_data.get(VENDOR, {}).get("model", "Generic Controller")
        identity.MajorMinorRevision = vendor_data.get(VENDOR, {}).get("version", "1.0.0")
        identities[unit_id] = identity

    context = ModbusServerContext(slaves=slave_contexts, single=False)
    return context, identities

def main():
    slaves_to_simulate = int(os.environ.get("MODBUS_SLAVES", 3))
    tcp_port = int(os.environ.get("MODBUS_PORT", 502))
    tcp_host = os.environ.get("MODBUS_HOST", "0.0.0.0")
    logger.info(f"Starting Modbus TCP Simulator for vendor '{VENDOR}' with {slaves_to_simulate} slaves on {tcp_host}:{tcp_port}")

    context, identities = setup_server(slaves=slaves_to_simulate)

    try:
        StartTcpServer(
            context=context,
            identity=identities[1],  # use first slave's identity
            address=(tcp_host, tcp_port)
        )
    except KeyboardInterrupt:
        logger.info(f"Shutting down Modbus TCP Simulator for vendor '{VENDOR}'")

if __name__ == "__main__":
    main()

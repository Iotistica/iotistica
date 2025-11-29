#!/usr/bin/env python3
"""
Generic Modbus TCP Simulator
Supports multiple slave IDs with vendor-specific data points loaded from JSON.
Environment Variables:
- MODBUS_VENDOR: name of the vendor to simulate (default: 'Generic')
- MODBUS_VENDOR_JSON: path to JSON file containing vendor data points (default: './vendors/dataPoints.json')
- MODBUS_SLAVES: number of slave IDs to simulate (default: 3)
- MODBUS_PORT: TCP port to listen on (default: 502)
"""
import logging
import time
import random
import os
import json
from pymodbus.server import StartTcpServer
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load vendor JSON
VENDOR = os.environ.get("MODBUS_VENDOR", "Generic")
JSON_FILE = os.environ.get("MODBUS_VENDOR_JSON", "./vendors/dataPoints.json")

try:
    with open(JSON_FILE, "r") as f:
        vendor_data = json.load(f)
except Exception as e:
    logger.warning(f"Failed to load vendor JSON '{JSON_FILE}': {e}")
    vendor_data = {}

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
        hr = VendorDataBlock(0, [0]*200)
        ir = VendorDataBlock(0, [0]*100)
        co = VendorDataBlock(0, [False]*20, is_coil=True)
        di = VendorDataBlock(0, [False]*20, is_coil=True)

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
    logger.info(f"Starting Modbus TCP Simulator for vendor '{VENDOR}' with {slaves_to_simulate} slaves on port {tcp_port}")

    context, identities = setup_server(slaves=slaves_to_simulate)

    try:
        StartTcpServer(
            context=context,
            identity=identities[1],  # use first slave's identity
            address=("0.0.0.0", tcp_port)
        )
    except KeyboardInterrupt:
        logger.info(f"Shutting down Modbus TCP Simulator for vendor '{VENDOR}'")

if __name__ == "__main__":
    main()

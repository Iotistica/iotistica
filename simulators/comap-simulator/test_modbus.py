#!/usr/bin/env python3
"""Quick test script for COMAP simulator Modbus connectivity."""

from pymodbus.client import ModbusTcpClient

def test_simulator():
    """Test reading registers from the COMAP simulator."""
    client = ModbusTcpClient('localhost', port=5502)
    
    if not client.connect():
        print("❌ Failed to connect to simulator")
        return
    
    print("✅ Connected to COMAP simulator on localhost:5502\n")
    
    # Test slave 1
    print("Testing Slave ID 1:")
    print("-" * 50)
    
    # Read RPM (register 100)
    result = client.read_holding_registers(100, 1, slave=1)
    if not result.isError():
        print(f"  Engine RPM: {result.registers[0]} RPM")
    
    # Read frequency (register 130, stored as Hz*100)
    result = client.read_holding_registers(130, 1, slave=1)
    if not result.isError():
        freq_hz = result.registers[0] / 100
        print(f"  Frequency: {freq_hz} Hz (raw: {result.registers[0]})")
    
    # Read 3-phase voltages (registers 110-112)
    result = client.read_holding_registers(110, 3, slave=1)
    if not result.isError():
        print(f"  Voltage L1-L2: {result.registers[0]} V")
        print(f"  Voltage L2-L3: {result.registers[1]} V")
        print(f"  Voltage L3-L1: {result.registers[2]} V")
    
    # Read power (register 140)
    result = client.read_holding_registers(140, 1, slave=1)
    if not result.isError():
        print(f"  Power Output: {result.registers[0]} kW")
    
    # Read alarms (coils 0-3)
    result = client.read_coils(0, 4, slave=1)
    if not result.isError():
        alarms = result.bits[:4]
        print(f"\n  Alarms:")
        print(f"    Overspeed: {'🔴 ACTIVE' if alarms[0] else '✅ OK'}")
        print(f"    Low Oil:   {'🔴 ACTIVE' if alarms[1] else '✅ OK'}")
        print(f"    High Temp: {'🔴 ACTIVE' if alarms[2] else '✅ OK'}")
        print(f"    Overload:  {'🔴 ACTIVE' if alarms[3] else '✅ OK'}")
    
    client.close()
    print("\n✅ Test completed successfully!")

if __name__ == "__main__":
    test_modbus()

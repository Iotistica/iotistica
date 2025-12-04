#!/usr/bin/env python3
"""
Live monitor for COMAP simulator - displays values in real-time.
Run: docker run --rm --network host -v ${PWD}:/app python:3.11-slim sh -c "pip install pymodbus && python /app/monitor_live.py"
"""

import time
import sys

try:
    from pymodbus.client import ModbusTcpClient
except ImportError:
    print("ERROR: pymodbus not installed")
    print("Install with: pip install pymodbus")
    sys.exit(1)


def clear_screen():
    """Clear terminal screen."""
    print("\033[2J\033[H", end="")


def monitor_live(host='localhost', port=5502, slave_id=1, interval=1):
    """Monitor simulator registers in real-time."""
    client = ModbusTcpClient(host, port=port)
    
    if not client.connect():
        print(f"❌ Failed to connect to {host}:{port}")
        return
    
    print(f"✅ Connected to COMAP simulator at {host}:{port}")
    print("Press Ctrl+C to exit\n")
    time.sleep(1)
    
    try:
        while True:
            clear_screen()
            print("=" * 60)
            print(f"  COMAP Generator Simulator - Live Monitor (Slave {slave_id})")
            print("=" * 60)
            print()
            
            # Read engine parameters
            result = client.read_holding_registers(100, 1, slave=slave_id)
            rpm = result.registers[0] if not result.isError() else 0
            
            result = client.read_holding_registers(130, 1, slave=slave_id)
            freq_raw = result.registers[0] if not result.isError() else 0
            frequency = freq_raw / 100.0
            
            result = client.read_holding_registers(150, 1, slave=slave_id)
            engine_temp = result.registers[0] if not result.isError() else 0
            
            result = client.read_holding_registers(170, 1, slave=slave_id)
            oil_pressure = result.registers[0] if not result.isError() else 0
            oil_psi = oil_pressure / 10.0
            
            # Read electrical parameters
            result = client.read_holding_registers(110, 3, slave=slave_id)
            if not result.isError():
                v_ab = result.registers[0]
                v_bc = result.registers[1]
                v_ca = result.registers[2]
            else:
                v_ab = v_bc = v_ca = 0
            
            result = client.read_holding_registers(120, 3, slave=slave_id)
            if not result.isError():
                i_a = result.registers[0] / 10.0
                i_b = result.registers[1] / 10.0
                i_c = result.registers[2] / 10.0
            else:
                i_a = i_b = i_c = 0
            
            result = client.read_holding_registers(140, 1, slave=slave_id)
            power_kw = result.registers[0] if not result.isError() else 0
            
            result = client.read_holding_registers(200, 1, slave=slave_id)
            pf_raw = result.registers[0] if not result.isError() else 0
            power_factor = pf_raw / 1000.0
            
            # Read auxiliary
            result = client.read_holding_registers(160, 1, slave=slave_id)
            fuel_level = result.registers[0] if not result.isError() else 0
            
            result = client.read_holding_registers(180, 1, slave=slave_id)
            battery_raw = result.registers[0] if not result.isError() else 0
            battery_voltage = battery_raw / 10.0
            
            result = client.read_holding_registers(190, 2, slave=slave_id)
            if not result.isError():
                run_hours = (result.registers[0] << 16) | result.registers[1]
            else:
                run_hours = 0
            
            # Read alarms
            result = client.read_coils(0, 4, slave=slave_id)
            if not result.isError():
                alarms = result.bits[:4]
                alarm_overspeed = alarms[0]
                alarm_low_oil = alarms[1]
                alarm_high_temp = alarms[2]
                alarm_overload = alarms[3]
            else:
                alarm_overspeed = alarm_low_oil = alarm_high_temp = alarm_overload = False
            
            # Display
            print("  ENGINE STATUS")
            print("  " + "-" * 56)
            print(f"    RPM:              {rpm:>6} RPM")
            print(f"    Frequency:        {frequency:>6.2f} Hz")
            print(f"    Engine Temp:      {engine_temp:>6} °C")
            print(f"    Oil Pressure:     {oil_psi:>6.1f} psi")
            print(f"    Run Hours:        {run_hours:>6} hrs")
            print()
            
            print("  ELECTRICAL OUTPUT (3-PHASE)")
            print("  " + "-" * 56)
            print(f"    Voltage L1-L2:    {v_ab:>6} V")
            print(f"    Voltage L2-L3:    {v_bc:>6} V")
            print(f"    Voltage L3-L1:    {v_ca:>6} V")
            print(f"    Current L1:       {i_a:>6.1f} A")
            print(f"    Current L2:       {i_b:>6.1f} A")
            print(f"    Current L3:       {i_c:>6.1f} A")
            print(f"    Power Output:     {power_kw:>6} kW")
            print(f"    Power Factor:     {power_factor:>6.3f}")
            print()
            
            print("  AUXILIARY")
            print("  " + "-" * 56)
            print(f"    Fuel Level:       {fuel_level:>6} %")
            print(f"    Battery Voltage:  {battery_voltage:>6.1f} V")
            print()
            
            print("  ALARMS")
            print("  " + "-" * 56)
            print(f"    Overspeed:        {'🔴 ACTIVE' if alarm_overspeed else '✅ OK'}")
            print(f"    Low Oil Pressure: {'🔴 ACTIVE' if alarm_low_oil else '✅ OK'}")
            print(f"    High Temperature: {'🔴 ACTIVE' if alarm_high_temp else '✅ OK'}")
            print(f"    Overload:         {'🔴 ACTIVE' if alarm_overload else '✅ OK'}")
            print()
            print("=" * 60)
            print(f"  Last update: {time.strftime('%Y-%m-%d %H:%M:%S')} | Refresh: {interval}s")
            print("  Press Ctrl+C to exit")
            
            time.sleep(interval)
            
    except KeyboardInterrupt:
        print("\n\n✅ Monitoring stopped")
    finally:
        client.close()


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Monitor COMAP simulator live')
    parser.add_argument('--host', default='localhost', help='Modbus TCP host')
    parser.add_argument('--port', type=int, default=5502, help='Modbus TCP port')
    parser.add_argument('--slave', type=int, default=1, help='Modbus slave ID')
    parser.add_argument('--interval', type=int, default=1, help='Refresh interval (seconds)')
    
    args = parser.parse_args()
    
    monitor_live(args.host, args.port, args.slave, args.interval)

#!/usr/bin/env python3
"""
CAN Bus Simulator for Iotistic Platform
Simulates automotive/industrial CAN bus messages
"""
import logging
import time
import random
import math
import socket
import struct
import threading

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class CANMessage:
    """CAN bus message structure"""
    def __init__(self, can_id, data, extended=False):
        self.can_id = can_id
        self.data = data
        self.extended = extended
        self.timestamp = time.time()
    
    def to_bytes(self):
        """Convert to socketcan format for TCP transmission"""
        # Simple format: [id(4)][dlc(1)][data(8)]
        dlc = len(self.data)
        return struct.pack('<I B 8s', self.can_id, dlc, bytes(self.data).ljust(8, b'\x00'))


class CANBusSimulator:
    """Simulates CAN bus with realistic automotive/industrial data"""
    
    def __init__(self, host='0.0.0.0', port=11898):
        self.host = host
        self.port = port
        self.running = False
        self.clients = []
        self.start_time = time.time()
        
    def generate_messages(self):
        """Generate realistic CAN messages"""
        elapsed = time.time() - self.start_time
        messages = []
        
        # Engine RPM (CAN ID 0x100) - 0-8000 RPM
        rpm = int(2000 + 1000 * math.sin(elapsed / 10.0) + random.uniform(-50, 50))
        rpm = max(0, min(8000, rpm))
        messages.append(CANMessage(0x100, list(rpm.to_bytes(2, 'big') + b'\x00' * 6)))
        
        # Vehicle Speed (CAN ID 0x101) - 0-200 km/h
        speed = int(60 + 30 * math.sin(elapsed / 20.0) + random.uniform(-2, 2))
        speed = max(0, min(200, speed))
        messages.append(CANMessage(0x101, list(speed.to_bytes(2, 'big') + b'\x00' * 6)))
        
        # Engine Temperature (CAN ID 0x102) - 60-110°C
        temp = int(85 + 10 * math.sin(elapsed / 60.0) + random.uniform(-1, 1))
        temp = max(60, min(110, temp))
        messages.append(CANMessage(0x102, [temp] + [0] * 7))
        
        # Throttle Position (CAN ID 0x103) - 0-100%
        throttle = int(50 + 30 * math.sin(elapsed / 15.0) + random.uniform(-2, 2))
        throttle = max(0, min(100, throttle))
        messages.append(CANMessage(0x103, [throttle] + [0] * 7))
        
        # Fuel Level (CAN ID 0x104) - 0-100%
        fuel = int(75 - elapsed / 300.0 + random.uniform(-0.5, 0.5))  # Slowly decreasing
        fuel = max(0, min(100, fuel))
        messages.append(CANMessage(0x104, [fuel] + [0] * 7))
        
        # Battery Voltage (CAN ID 0x105) - 11.0-14.5V (in 0.1V units)
        voltage = int((13.8 + 0.5 * math.sin(elapsed / 30.0) + random.uniform(-0.1, 0.1)) * 10)
        voltage = max(110, min(145, voltage))
        messages.append(CANMessage(0x105, list(voltage.to_bytes(2, 'big') + b'\x00' * 6)))
        
        # Oil Pressure (CAN ID 0x106) - 200-600 kPa
        oil_pressure = int(400 + 100 * math.sin(elapsed / 25.0) + random.uniform(-5, 5))
        oil_pressure = max(200, min(600, oil_pressure))
        messages.append(CANMessage(0x106, list(oil_pressure.to_bytes(2, 'big') + b'\x00' * 6)))
        
        # Brake Pressure (CAN ID 0x107) - 0-1000 kPa
        brake = int(100 + 200 * abs(math.sin(elapsed / 12.0)) + random.uniform(-10, 10))
        brake = max(0, min(1000, brake))
        messages.append(CANMessage(0x107, list(brake.to_bytes(2, 'big') + b'\x00' * 6)))
        
        # Coolant Temperature (CAN ID 0x108) - 60-105°C
        coolant = int(82 + 8 * math.sin(elapsed / 50.0) + random.uniform(-1, 1))
        coolant = max(60, min(105, coolant))
        messages.append(CANMessage(0x108, [coolant] + [0] * 7))
        
        # Air Flow (CAN ID 0x109) - 0-500 kg/h
        airflow = int(150 + 100 * abs(math.sin(elapsed / 18.0)) + random.uniform(-5, 5))
        airflow = max(0, min(500, airflow))
        messages.append(CANMessage(0x109, list(airflow.to_bytes(2, 'big') + b'\x00' * 6)))
        
        return messages
    
    def handle_client(self, client_socket, address):
        """Handle individual client connection"""
        logger.info(f"Client connected from {address}")
        self.clients.append(client_socket)
        
        try:
            while self.running:
                # Generate and send CAN messages
                messages = self.generate_messages()
                for msg in messages:
                    try:
                        client_socket.sendall(msg.to_bytes())
                    except (BrokenPipeError, ConnectionResetError):
                        logger.info(f"Client {address} disconnected")
                        break
                
                time.sleep(0.1)  # 10 messages/second per CAN ID
                
        except Exception as e:
            logger.error(f"Error handling client {address}: {e}")
        finally:
            if client_socket in self.clients:
                self.clients.remove(client_socket)
            client_socket.close()
    
    def start(self):
        """Start the CAN bus simulator server"""
        self.running = True
        server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server_socket.bind((self.host, self.port))
        server_socket.listen(5)
        
        logger.info(f"CAN Bus Simulator listening on {self.host}:{self.port}")
        logger.info("Simulating 10 CAN IDs with realistic automotive/industrial data:")
        logger.info("  - 0x100: Engine RPM (0-8000)")
        logger.info("  - 0x101: Vehicle Speed (0-200 km/h)")
        logger.info("  - 0x102: Engine Temperature (60-110°C)")
        logger.info("  - 0x103: Throttle Position (0-100%)")
        logger.info("  - 0x104: Fuel Level (0-100%)")
        logger.info("  - 0x105: Battery Voltage (11.0-14.5V)")
        logger.info("  - 0x106: Oil Pressure (200-600 kPa)")
        logger.info("  - 0x107: Brake Pressure (0-1000 kPa)")
        logger.info("  - 0x108: Coolant Temperature (60-105°C)")
        logger.info("  - 0x109: Air Flow (0-500 kg/h)")
        
        try:
            while self.running:
                try:
                    server_socket.settimeout(1.0)
                    client_socket, address = server_socket.accept()
                    client_thread = threading.Thread(
                        target=self.handle_client,
                        args=(client_socket, address),
                        daemon=True
                    )
                    client_thread.start()
                except socket.timeout:
                    continue
        except KeyboardInterrupt:
            logger.info("Shutting down CAN Bus Simulator")
        finally:
            self.running = False
            for client in self.clients:
                client.close()
            server_socket.close()


def main():
    simulator = CANBusSimulator()
    simulator.start()


if __name__ == '__main__':
    main()

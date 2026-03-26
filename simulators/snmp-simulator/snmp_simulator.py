#!/usr/bin/env python3
"""
SNMP Simulator for Iotistic Platform
Simulates network devices and sensors with realistic MIB-II and custom OID data
"""
import logging
import time
import random
import math
from pysnmp.entity import engine, config
from pysnmp.entity.rfc3413 import cmdrsp, context
from pysnmp.carrier.asyncore.dgram import udp
from pysnmp.proto.api import v2c
from pysnmp.smi import instrum, builder
from pyasn1.type.univ import Integer, OctetString, ObjectIdentifier
from pysnmp.proto.rfc1902 import Counter32, Gauge32, TimeTicks

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class DynamicMibInstrumController(instrum.MibInstrumController):
    """Custom MIB controller that generates values dynamically"""
    
    def __init__(self, mibBuilder, start_time):
        instrum.MibInstrumController.__init__(self, mibBuilder)
        self.start_time = start_time
        self.uptime_start = time.time()
    
    def readVars(self, varBinds, acInfo=(None, None)):
        """Override to generate dynamic values for any requested OID"""
        result_varBinds = []
        
        for oid, val in varBinds:
            oid_str = '.'.join([str(x) for x in oid])
            generated_val = self._generate_value_for_oid(oid_str)
            
            if generated_val is not None:
                result_varBinds.append((oid, generated_val))
            else:
                # Return NoSuchObject if we don't handle this OID
                result_varBinds.append((oid, v2c.NoSuchObject('')))
        
        return result_varBinds
    
    def _generate_value_for_oid(self, oid_str):
        """Generate realistic values for common OIDs"""
        elapsed = time.time() - self.start_time
        
        # System Group (1.3.6.1.2.1.1.x)
        if oid_str == '1.3.6.1.2.1.1.1.0':  # sysDescr
            return OctetString('Iotistic SNMP Simulator v1.0.0')
        
        elif oid_str == '1.3.6.1.2.1.1.2.0':  # sysObjectID
            return ObjectIdentifier('1.3.6.1.4.1.99999.1.1')
        
        elif oid_str == '1.3.6.1.2.1.1.3.0':  # sysUpTime (timeticks)
            uptime = int((time.time() - self.uptime_start) * 100)  # centiseconds
            return TimeTicks(uptime)
        
        elif oid_str == '1.3.6.1.2.1.1.4.0':  # sysContact
            return OctetString('admin@iotistica.com')
        
        elif oid_str == '1.3.6.1.2.1.1.5.0':  # sysName
            return OctetString('iotistic-snmp-simulator')
        
        elif oid_str == '1.3.6.1.2.1.1.6.0':  # sysLocation
            return OctetString('Iotistic Lab, Vancouver, BC')
        
        elif oid_str == '1.3.6.1.2.1.1.7.0':  # sysServices
            return Integer(72)  # Application + End-to-End layers
        
        # Interface Group (1.3.6.1.2.1.2.x)
        elif oid_str == '1.3.6.1.2.1.2.1.0':  # ifNumber
            return Integer(2)  # Two interfaces
        
        # Interface Table - eth0 (index 1)
        elif oid_str == '1.3.6.1.2.1.2.2.1.1.1':  # ifIndex
            return Integer(1)
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.2.1':  # ifDescr
            return OctetString('eth0')
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.3.1':  # ifType
            return Integer(6)  # ethernetCsmacd
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.4.1':  # ifMtu
            return Integer(1500)
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.5.1':  # ifSpeed
            return Gauge32(1000000000)  # 1 Gbps
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.8.1':  # ifOperStatus
            return Integer(1)  # up
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.10.1':  # ifInOctets (with sine wave)
            base = 1000000000  # 1GB baseline
            variation = int(50000000 * math.sin(elapsed / 30.0))
            return Counter32(base + variation + int(elapsed * 1000000))
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.11.1':  # ifInUcastPkts
            return Counter32(int(500000 + elapsed * 100))
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.13.1':  # ifInDiscards
            return Counter32(random.randint(0, 10))
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.14.1':  # ifInErrors
            return Counter32(random.randint(0, 5))
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.16.1':  # ifOutOctets
            base = 800000000  # 800MB baseline
            variation = int(40000000 * math.sin(elapsed / 25.0))
            return Counter32(base + variation + int(elapsed * 800000))
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.17.1':  # ifOutUcastPkts
            return Counter32(int(400000 + elapsed * 80))
        
        # Interface Table - lo (index 2)
        elif oid_str == '1.3.6.1.2.1.2.2.1.1.2':  # ifIndex
            return Integer(2)
        
        elif oid_str == '1.3.6.1.2.1.2.2.1.2.2':  # ifDescr
            return OctetString('lo')
        
        # IP Group (1.3.6.1.2.1.4.x)
        elif oid_str == '1.3.6.1.2.1.4.3.0':  # ipInReceives
            return Counter32(int(1000000 + elapsed * 500))
        
        elif oid_str == '1.3.6.1.2.1.4.9.0':  # ipInDelivers
            return Counter32(int(950000 + elapsed * 450))
        
        elif oid_str == '1.3.6.1.2.1.4.10.0':  # ipOutRequests
            return Counter32(int(900000 + elapsed * 400))
        
        # ICMP Group (1.3.6.1.2.1.5.x)
        elif oid_str == '1.3.6.1.2.1.5.1.0':  # icmpInMsgs
            return Counter32(int(50000 + elapsed * 10))
        
        elif oid_str == '1.3.6.1.2.1.5.14.0':  # icmpOutMsgs
            return Counter32(int(48000 + elapsed * 9))
        
        # TCP Group (1.3.6.1.2.1.6.x)
        elif oid_str == '1.3.6.1.2.1.6.5.0':  # tcpActiveOpens
            return Counter32(int(1000 + elapsed * 2))
        
        elif oid_str == '1.3.6.1.2.1.6.9.0':  # tcpCurrEstab
            return Gauge32(random.randint(10, 50))
        
        # UDP Group (1.3.6.1.2.1.7.x)
        elif oid_str == '1.3.6.1.2.1.7.1.0':  # udpInDatagrams
            return Counter32(int(200000 + elapsed * 100))
        
        elif oid_str == '1.3.6.1.2.1.7.4.0':  # udpOutDatagrams
            return Counter32(int(180000 + elapsed * 90))
        
        # Host Resources MIB - Storage (1.3.6.1.2.1.25.2.x)
        elif oid_str == '1.3.6.1.2.1.25.2.2.0':  # hrMemorySize (KB)
            return Integer(16777216)  # 16 GB
        
        elif oid_str == '1.3.6.1.2.1.25.2.3.1.5.1':  # hrStorageSize (disk)
            return Integer(524288000)  # 500 GB
        
        elif oid_str == '1.3.6.1.2.1.25.2.3.1.6.1':  # hrStorageUsed
            base = 262144000  # 250 GB baseline
            variation = int(10000000 * math.sin(elapsed / 3600.0))
            return Integer(base + variation)
        
        # Host Resources - Processor Load (1.3.6.1.2.1.25.3.3.1.2.x)
        elif oid_str.startswith('1.3.6.1.2.1.25.3.3.1.2.'):
            base_load = 30
            variation = int(20 * math.sin(elapsed / 45.0))
            noise = random.randint(-5, 5)
            return Integer(max(0, min(100, base_load + variation + noise)))
        
        # Custom Enterprise OIDs for sensors (1.3.6.1.4.1.99999.x)
        # Temperature sensors
        elif oid_str.startswith('1.3.6.1.4.1.99999.1.1.'):
            sensor_id = int(oid_str.split('.')[-1])
            base_temp = 25.0
            variation = 5.0 * math.sin(elapsed / 30.0 + sensor_id * 0.5)
            noise = random.uniform(-0.5, 0.5)
            return Integer(int((base_temp + variation + noise) * 10))
        
        # Humidity sensors
        elif oid_str.startswith('1.3.6.1.4.1.99999.1.2.'):
            sensor_id = int(oid_str.split('.')[-1])
            base_humidity = 55
            variation = 15 * math.sin(elapsed / 60.0 + sensor_id * 0.4)
            noise = random.uniform(-1, 1)
            return Integer(int(max(0, min(100, base_humidity + variation + noise))))
        
        # Pressure sensors
        elif oid_str.startswith('1.3.6.1.4.1.99999.1.3.'):
            sensor_id = int(oid_str.split('.')[-1])
            base_pressure = 1013
            variation = 20 * math.sin(elapsed / 90.0 + sensor_id * 0.3)
            noise = random.uniform(-2, 2)
            return Integer(int(base_pressure + variation + noise))
        
        # Power consumption
        elif oid_str.startswith('1.3.6.1.4.1.99999.1.4.'):
            sensor_id = int(oid_str.split('.')[-1])
            base_power = 5000
            variation = 2000 * math.sin(elapsed / 25.0 + sensor_id * 0.8)
            noise = random.uniform(-50, 50)
            return Integer(int(max(0, base_power + variation + noise)))
        
        return None


class SNMPSimulator:
    """SNMP Agent Simulator with dynamic data generation"""
    
    def __init__(self, host='0.0.0.0', port=161, community='public'):
        self.host = host
        self.port = port
        self.community = community
        self.start_time = int(time.time())
        self.uptime_start = time.time()
        
        # Initialize SNMP engine
        self.snmp_engine = engine.SnmpEngine()
        
        # Setup transport
        config.addTransport(
            self.snmp_engine,
            udp.domainName,
            udp.UdpTransport().openServerMode((self.host, self.port))
        )
        
        # Setup community
        config.addV1System(self.snmp_engine, 'agent', self.community)
        
        # Setup default context first
        self.snmp_context = context.SnmpContext(self.snmp_engine)
        
        # Replace MIB instrumentation controller with our custom one
        mib_builder = self.snmp_context.getMibInstrum().mibBuilder
        mib_instrum_controller = DynamicMibInstrumController(mib_builder, self.start_time)
        self.snmp_context.unregisterContextName(v2c.OctetString(''))
        self.snmp_context.registerContextName(v2c.OctetString(''), mib_instrum_controller)
        
        # Setup MIB view
        config.addVacmUser(
            self.snmp_engine, 1, 'agent', 'noAuthNoPriv',
            readSubTree=(1, 3, 6, 1),
            writeSubTree=(1, 3, 6, 1)
        )
        
        # Register SNMP Applications at the SNMP engine
        cmdrsp.GetCommandResponder(self.snmp_engine, self.snmp_context)
        cmdrsp.SetCommandResponder(self.snmp_engine, self.snmp_context)
        cmdrsp.NextCommandResponder(self.snmp_engine, self.snmp_context)
        cmdrsp.BulkCommandResponder(self.snmp_engine, self.snmp_context)
        
        logger.info(f"SNMP Simulator initialized on {host}:{port}")
        logger.info(f"Community string: {community}")
    
    def run(self):
        """Start the SNMP simulator"""
        logger.info("=" * 60)
        logger.info("SNMP Simulator Started")
        logger.info("=" * 60)
        logger.info(f"Listening on: {self.host}:{self.port}")
        logger.info(f"Community: {self.community}")
        logger.info("")
        logger.info("Available OIDs:")
        logger.info("  System Group (1.3.6.1.2.1.1.x):")
        logger.info("    - .1.0  sysDescr")
        logger.info("    - .3.0  sysUpTime")
        logger.info("    - .5.0  sysName")
        logger.info("    - .6.0  sysLocation")
        logger.info("")
        logger.info("  Interface Group (1.3.6.1.2.1.2.x):")
        logger.info("    - .2.2.1.10.1  ifInOctets (eth0)")
        logger.info("    - .2.2.1.16.1  ifOutOctets (eth0)")
        logger.info("    - .2.2.1.5.1   ifSpeed")
        logger.info("    - .2.2.1.8.1   ifOperStatus")
        logger.info("")
        logger.info("  Host Resources (1.3.6.1.2.1.25.x):")
        logger.info("    - .2.2.0        hrMemorySize")
        logger.info("    - .3.3.1.2.1    hrProcessorLoad")
        logger.info("")
        logger.info("  Custom Sensors (1.3.6.1.4.1.99999.1.x):")
        logger.info("    - .1.1.0  Temperature sensor 1 (°C * 10)")
        logger.info("    - .1.2.0  Humidity sensor 1 (%)")
        logger.info("    - .1.3.0  Pressure sensor 1 (mbar)")
        logger.info("    - .1.4.0  Power sensor 1 (W)")
        logger.info("")
        logger.info("Test with: snmpwalk -v2c -c public localhost")
        logger.info("=" * 60)
        
        try:
            self.snmp_engine.transportDispatcher.jobStarted(1)
            self.snmp_engine.transportDispatcher.runDispatcher()
        except KeyboardInterrupt:
            logger.info("\nShutting down SNMP Simulator")
        except Exception as e:
            logger.error(f"Error running simulator: {e}", exc_info=True)
        finally:
            self.snmp_engine.transportDispatcher.closeDispatcher()


def main():
    """Main entry point"""
    simulator = SNMPSimulator(
        host='0.0.0.0',
        port=161,
        community='public'
    )
    simulator.run()


if __name__ == '__main__':
    main()

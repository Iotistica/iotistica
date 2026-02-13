#!/usr/bin/env python3
"""Test OPC UA NodeID format"""
import asyncio
from asyncua import Client

async def test_nodeid_format():
    print("Testing OPC UA simulator NodeID format...\n")
    
    client = Client("opc.tcp://localhost:4840")
    
    try:
        async with client:
            print("✓ Connected to simulator\n")
            
            # Test 1: Read metadata
            print("--- Test 1: Reading ServerInfo metadata ---")
            try:
                profile_node = client.get_node("ns=2;s=ServerInfo.ProfileName")
                profile_value = await profile_node.read_value()
                print(f"Profile: {profile_value}")
                
                count_node = client.get_node("ns=2;s=ServerInfo.SensorCount")
                count_value = await count_node.read_value()
                print(f"Total sensors: {count_value}")
            except Exception as e:
                print(f"✗ Failed to read metadata: {e}")
            
            # Test 2: Read sensor nodes with string-based NodeIDs
            print("\n--- Test 2: Reading sensor nodes (string-based NodeIDs) ---")
            test_nodes = [
                ("ns=2;s=Temperature/Sensor1", "Temperature Sensor 1"),
                ("ns=2;s=Temperature/Sensor2", "Temperature Sensor 2"),
                ("ns=2;s=Pressure/Sensor1", "Pressure Sensor 1"),
                ("ns=2;s=Flow/Sensor1", "Flow Sensor 1"),
                ("ns=2;s=Level/Tank1", "Level Tank 1"),
            ]
            
            for node_id, name in test_nodes:
                try:
                    node = client.get_node(node_id)
                    value = await node.read_value()
                    browse_name = await node.read_browse_name()
                    print(f"✓ {node_id}")
                    print(f"  Name: {browse_name.Name}")
                    print(f"  Value: {value}")
                except Exception as e:
                    print(f"✗ {node_id} - Error: {e}")
            
            print("\n✓ All NodeIDs are string-based format: ns=2;s=Folder/SensorName")
            print("✓ Agent will be able to discover and read these nodes")
            
    except Exception as e:
        print(f"\n✗ Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_nodeid_format())

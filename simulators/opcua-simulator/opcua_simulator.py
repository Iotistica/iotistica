#!/usr/bin/env python3
"""
OPC UA Simulator for Iotistic Platform
Main entry point - now using modular architecture
"""
import asyncio
from lib import main

if __name__ == '__main__':
    asyncio.run(main())

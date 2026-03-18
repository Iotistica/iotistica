"""
Value updater - async loop for updating device values
"""
import logging
import asyncio
import time
from typing import List
from .types import Device
from .models import get_model

logger = logging.getLogger(__name__)


class ValueUpdater:
    """Manages periodic updates to device node values"""
    
    def __init__(self, devices: List[Device], update_interval: float = 1.0):
        self.devices = devices
        self.update_interval = update_interval
        self.start_time = time.time()
        self.running = False
        
        # Initialize model instances for each device with their config
        for device in self.devices:
            config = device.config or {}
            device.model = get_model(device.model_type, config)
        
        logger.info(f"ValueUpdater initialized with {len(devices)} devices")
    
    async def update_cycle(self):
        """Single update cycle for all nodes"""
        elapsed = time.time() - self.start_time
        
        for device in self.devices:
            try:
                # Generate new value using device model
                value = device.model.generate(elapsed, device.index)
                
                # Apply constraints if defined
                if device.min_value is not None:
                    value = max(value, device.min_value)
                if device.max_value is not None:
                    value = min(value, device.max_value)
                
                # Write to OPC UA node
                await device.node.write_value(value)

                logger.info(
                    f"[OPC UA] Published: device={device.name!r}"
                    f"  folder={device.folder!r}"
                    f"  uuid={device.uuid!r}"
                    f"  value={value}"
                    f"  unit={device.unit!r}"
                )

            except Exception as e:
                logger.error(f"Error updating device {device.name}: {e}")
    
    async def start(self):
        """Start continuous update loop"""
        self.running = True
        logger.info(f"Starting value updater (interval: {self.update_interval}s)")
        
        update_count = 0
        while self.running:
            try:
                await self.update_cycle()
                update_count += 1
                
                if update_count % 60 == 0:  # Log every 60 cycles
                    logger.debug(f"Completed {update_count} update cycles")
                
                await asyncio.sleep(self.update_interval)
                
            except Exception as e:
                logger.error(f"Error in update loop: {e}")
                await asyncio.sleep(self.update_interval)
    
    def stop(self):
        """Stop update loop"""
        self.running = False
        logger.info("Value updater stopped")

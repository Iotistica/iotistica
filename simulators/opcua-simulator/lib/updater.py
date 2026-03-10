"""
Value updater - async loop for updating sensor values
"""
import logging
import asyncio
import time
from typing import List
from .types import Sensor
from .models import get_model

logger = logging.getLogger(__name__)


class ValueUpdater:
    """Manages periodic updates to sensor node values"""
    
    def __init__(self, sensors: List[Sensor], update_interval: float = 1.0):
        self.sensors = sensors
        self.update_interval = update_interval
        self.start_time = time.time()
        self.running = False
        
        # Initialize model instances for each sensor with their config
        for sensor in self.sensors:
            config = sensor.config or {}
            sensor.model = get_model(sensor.model_type, config)
        
        logger.info(f"ValueUpdater initialized with {len(sensors)} sensors")
    
    async def update_cycle(self):
        """Single update cycle for all nodes"""
        elapsed = time.time() - self.start_time
        
        for sensor in self.sensors:
            try:
                # Generate new value using sensor's model
                value = sensor.model.generate(elapsed, sensor.index)
                
                # Apply constraints if defined
                if sensor.min_value is not None:
                    value = max(value, sensor.min_value)
                if sensor.max_value is not None:
                    value = min(value, sensor.max_value)
                
                # Write to OPC UA node
                await sensor.node.write_value(value)
                
            except Exception as e:
                logger.error(f"Error updating sensor {sensor.name}: {e}")
    
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

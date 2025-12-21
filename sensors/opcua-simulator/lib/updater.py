"""
Value updater - async loop for updating sensor values
"""
import logging
import asyncio
import time
from typing import Dict, Any
from .models import get_model
from .nodes import NodeManager

logger = logging.getLogger(__name__)


class ValueUpdater:
    """Manages periodic updates to sensor node values"""
    
    def __init__(self, node_manager: NodeManager, update_interval: float = 1.0):
        self.node_manager = node_manager
        self.update_interval = update_interval
        self.start_time = time.time()
        self.running = False
        self.models_cache: Dict[str, Any] = {}
        
    def _get_model(self, model_type: str):
        """Get cached model instance"""
        if model_type not in self.models_cache:
            self.models_cache[model_type] = get_model(model_type)
        return self.models_cache[model_type]
    
    async def update_cycle(self):
        """Single update cycle for all nodes"""
        elapsed = time.time() - self.start_time
        nodes = self.node_manager.get_all_nodes()
        
        for key, node in nodes.items():
            try:
                metadata = self.node_manager.get_node_metadata(key)
                model_type = metadata.get('model', 'oscillating')
                index = metadata.get('index', 0)
                
                # Get model and generate value
                model = self._get_model(model_type)
                value = model.generate(elapsed, index)
                
                # Update node
                await node.write_value(value)
                
            except Exception as e:
                logger.error(f"Error updating node {key}: {e}")
    
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

#!/usr/bin/env python3
import sys
import os
sys.path.insert(0, '/app')
os.environ['MODBUS_PROFILE'] = 'COMAP'

from modbus_simulator import PROFILE_INDEX

comap_index = PROFILE_INDEX.get('COMAP', {})
print(f'\nCOMAP profile index has {len(comap_index)} entries:\n')

for key in sorted(comap_index.keys()):
    register_type, address = key
    dp = comap_index[key]
    name = dp.get('name', 'unknown')
    base = dp.get('base', 'N/A')
    print(f'  ({register_type:10s}, {address:3d}): {name:20s} base={base}')

#!/bin/bash
# Start both Modbus server and Web GUI

# Start Modbus server in background
python -u modbus_simulator.py &
MODBUS_PID=$!

# Start Web GUI in foreground
python -u web_gui.py &
GUI_PID=$!

# Wait for both processes
wait $MODBUS_PID $GUI_PID

#!/bin/bash
# Cleanup script for background processes
# usage: ./cleanup-processes.sh [port]

set -e

PORT="${1:-4111}"

echo "Checking for processes using port $PORT..."

# Find and kill processes using the specified port
if command -v lsof &> /dev/null; then
    echo "Using lsof to find processes..."
    lsof -ti :$PORT | xargs -r ps -fp
    echo "Killing processes on port $PORT..."
    lsof -ti :$PORT | xargs -r kill -9
elif command -v fuser &> /dev/null; then
    echo "Using fuser to find processes..."
    fuser -v $PORT/tcp 2>/dev/null || true
    echo "Killing processes on port $PORT..."
    fuser -k $PORT/tcp 2>/dev/null || true
else
    echo "Error: Neither lsof nor fuser found. Please install one of them."
    exit 1
fi

# Clean up any zombie/stuck processes by name pattern
echo "Cleaning up stuck Python/Node processes..."
pkill -f "python.*main.py" 2>/dev/null || true
pkill -f "node.*server" 2>/dev/null || true

# Also kill any processes with the specific port in their command line
echo "Killing any processes with port $PORT in command line..."
ps aux | grep -v grep | grep ":$PORT" | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true

# Show remaining processes on this port
echo "Remaining processes on port $PORT:"
if command -v lsof &> /dev/null; then
    lsof -i :$PORT 2>/dev/null || echo "No processes found on port $PORT"
else
    netstat -tlnp 2>/dev/null | grep ":$PORT" || echo "No processes found on port $PORT"
fi

echo "Cleanup complete!"
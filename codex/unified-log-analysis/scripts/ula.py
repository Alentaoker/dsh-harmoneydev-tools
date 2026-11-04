#!/usr/bin/env python3
"""Portable, passive entry point. Use python -I /absolute/path/ula.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ula.cli import main

if __name__ == '__main__':
    main()

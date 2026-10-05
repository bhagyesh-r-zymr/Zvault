#!/usr/bin/env python3
"""Fails when line coverage of the hand-written Dart code is below a threshold.

Usage: check_coverage.py [min_percent] [lcov_file]

The flutter_rust_bridge output under lib/src/rust/ is generated and only runs
with the native Rust library (the emulator job covers that), so it is left out.
"""
import sys

minimum = float(sys.argv[1]) if len(sys.argv) > 1 else 80.0
path = sys.argv[2] if len(sys.argv) > 2 else "coverage/lcov.info"

found = hit = 0
current = None
skip = False
for line in open(path):
    line = line.strip()
    if line.startswith("SF:"):
        current = line[3:]
        skip = "/src/rust/" in current
    elif line.startswith("LF:") and not skip:
        found += int(line[3:])
    elif line.startswith("LH:") and not skip:
        hit += int(line[3:])

percent = 100 * hit / found if found else 0.0
print(f"Dart line coverage (generated bridge code excluded): {percent:.1f}% ({hit} of {found})")
if percent < minimum:
    print(f"Below the {minimum:.0f}% minimum.")
    sys.exit(1)

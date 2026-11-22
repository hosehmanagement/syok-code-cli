import re

UNITS = {'d': 86400, 'h': 3600, 'm': 60, 's': 1}

def parse_duration(text):
    total = 0
    for num, unit in re.findall(r'(\d+)([a-z])', text):
        total += int(num) * UNITS['s']
    return total

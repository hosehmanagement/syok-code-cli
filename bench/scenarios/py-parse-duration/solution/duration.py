import re

UNITS = {'d': 86400, 'h': 3600, 'm': 60, 's': 1}

def parse_duration(text):
    if not re.fullmatch(r'(\d+[dhms])+', text or ''):
        raise ValueError('bad duration: %r' % (text,))
    total = 0
    for num, unit in re.findall(r'(\d+)([dhms])', text):
        total += int(num) * UNITS[unit]
    return total

#!/usr/bin/env python3
"""Test files for the live checks (gaps-live.sh), made with the Python standard library only (no Pillow needed).

  make-fixture.py biglog <file> <megabytes>   a large service log with ONE error line; prints that line's random code
  make-fixture.py png <file>                  a picture of a random 5-digit number under a coloured bar; prints "<number> <colour>"

The secret facts are random on every run and never appear in a file name or in the prompt, so an answer that holds them
can only come from really looking inside the file."""
import random, struct, sys, zlib

rng = random.SystemRandom()


def biglog(path, megabytes):
    code = "ZX-%04d-%s" % (rng.randrange(1000, 10000), rng.choice("ABCDEFGHJKMNPQRSTUVWXYZ"))
    target = megabytes * 1024 * 1024
    paths = ["/api/items", "/api/cart", "/api/users/me", "/api/search", "/health", "/api/orders"]
    written, i, planted = 0, 0, False
    at = target // 2 + rng.randrange(-target // 8, target // 8)  # somewhere in the middle, not at the start or end
    with open(path, "w", buffering=1 << 20) as f:
        chunk = []
        while written < target:
            i += 1
            s = i % 86400
            ts = "2026-11-22T%02d:%02d:%02d.%03dZ" % (s // 3600, s // 60 % 60, s % 60, i % 1000)
            r = i % 97
            if r == 13:
                line = "%s WARN  cache: miss for key=user:%d, loading from the database\n" % (ts, i % 50000)
            elif r == 41:
                line = "%s WARN  http: upstream slow, took %d ms (limit 800 ms)\n" % (ts, 800 + i % 900)
            else:
                line = "%s INFO  http: %s %s status=200 ms=%d req=%08x\n" % (ts, "GET" if i % 3 else "POST", paths[i % len(paths)], 3 + i % 40, (i * 2654435761) & 0xFFFFFFFF)
            if not planted and written >= at:
                line += "%s ERROR payments: ledger write rejected for batch %d, code=%s, all later payments were queued\n" % (ts, 7000 + i % 1000, code)
                planted = True
            chunk.append(line); written += len(line)
            if len(chunk) >= 20000:
                f.write("".join(chunk)); chunk = []
        f.write("".join(chunk))
    print(code)


# A 5x7 font for the digits 0-9.
FONT = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}
COLOURS = {"red": (230, 0, 0), "green": (0, 170, 0), "blue": (0, 60, 230)}


def png(path):
    number = str(rng.randrange(10000, 100000))
    colour = rng.choice(sorted(COLOURS))
    scale, gap, margin, bar = 14, 2, 4, 6  # in font pixels
    cols = margin * 2 + len(number) * 5 + (len(number) - 1) * gap
    rows = bar + margin * 2 + 7
    W, H = cols * scale, rows * scale
    ink, white = (20, 20, 20), (255, 255, 255)
    grid = [[white] * cols for _ in range(rows)]
    for y in range(bar):
        for x in range(cols):
            grid[y][x] = COLOURS[colour]
    for n, d in enumerate(number):
        x0 = margin + n * (5 + gap)
        for y, row in enumerate(FONT[d]):
            for x, bit in enumerate(row):
                if bit == "1":
                    grid[bar + margin + y][x0 + x] = ink
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        line = grid[y // scale]
        for x in range(W):
            raw.extend(line[x // scale])

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    print(number, colour)


if __name__ == "__main__":
    if sys.argv[1] == "biglog":
        biglog(sys.argv[2], int(sys.argv[3]))
    elif sys.argv[1] == "png":
        png(sys.argv[2])
    else:
        sys.exit("unknown fixture " + sys.argv[1])

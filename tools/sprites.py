"""Pull 16x16 sprites from Pixel Search (huggingface.co/spaces/cfahlgren1/pixel-search).

Pixel Search serves the full CC0 catalog of Angais/pixel-art-atlas-1.4m as static files:
subjects.txt (sorted names), catalog-subjects.bin (u32 start of each subject), palette.bin
(4097 RGB colours, index 0 transparent) and pages/<n>.bin (256 sprites each, local palettes).
Catalog ids are sorted by subject, so a subject's sprites are a contiguous id range.

Usage (stdlib only, run from anywhere):
  python3 -I tools/sprites.py find <regex>                 # list subjects matching a pattern, with counts
  python3 -I tools/sprites.py contact <slot> [out.png]     # numbered sheet of a slot's subjects
  python3 -I tools/sprites.py pick <slot> <n> [<n> ...]    # store contact-sheet numbers as the slot's picks
  python3 -I tools/sprites.py build                        # export sprites + write design/concept-sheet.html

Slots live in tools/sprite_slots.json: {"slot": {"subjects": [...], "picks": [ids], "chosen": id}}.
"browse" (default 48) caps how many sprites per subject the contact sheet shows.
"""
import base64, gzip, json, os, struct, sys, urllib.request, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "pixel-search")
BASE = "https://huggingface.co/spaces/cfahlgren1/pixel-search/resolve/main/static/data/"
PAGE = 256


def fetch(name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with urllib.request.urlopen(BASE + name, timeout=60) as response:
            data = response.read()
        with open(path + ".tmp", "wb") as handle:
            handle.write(data)
        os.replace(path + ".tmp", path)
    with open(path, "rb") as handle:
        return gzip.decompress(handle.read())


class Catalog:
    def __init__(self):
        self.subjects = fetch("subjects.txt.z").decode().split("\n")
        raw = fetch("catalog-subjects.bin.z")
        self.starts = struct.unpack(f"<{len(raw) // 4}I", raw)
        self.palette = fetch("palette.bin.z")
        self.total = self.starts[-1]
        self.pages = {}

    def subject_range(self, name):
        i = self.subjects.index(name)
        return self.starts[i], self.starts[i + 1]

    def subject_of(self, sprite):
        lo, hi = 0, len(self.starts) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            lo, hi = (mid, hi) if self.starts[mid] <= sprite else (lo, mid)
        return self.subjects[lo]

    def rgba(self, sprite):
        """Returns 16*16*4 bytes of straight RGBA."""
        page = sprite // PAGE
        if page not in self.pages:
            self.pages[page] = fetch(f"pages/{page}.bin.z")
        data = self.pages[page]
        count = min(PAGE, self.total - page * PAGE)
        offset = sprite - page * PAGE
        colors = count + 2 * sum(data[:offset])
        indices = count + 2 * sum(data[:count]) + offset * 256
        out = bytearray(256 * 4)
        for p in range(256):
            local = data[indices + p]
            token = data[colors + local * 2] | (data[colors + local * 2 + 1] << 8)
            if token:
                out[p * 4:p * 4 + 4] = bytes(self.palette[token * 3:token * 3 + 3]) + b"\xff"
        return bytes(out)


def png(width, height, rgba):
    rows = b"".join(b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


# 3x5 digits for contact-sheet labels.
DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
          "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"]


def browse_list(catalog, slot):
    sprites = []
    for subject in slot["subjects"]:
        lo, hi = catalog.subject_range(subject)
        sprites += [(subject, i - lo, i) for i in range(lo, min(hi, lo + slot.get("browse", 48)))]
    return sprites


def find(catalog, pattern):
    import re
    rx = re.compile(pattern, re.I)
    for i, name in enumerate(catalog.subjects):
        if rx.search(name):
            print(f"{name}  ({catalog.starts[i + 1] - catalog.starts[i]})")


def pick(catalog, slot_name, numbers):
    slots = load_slots()
    sprites = browse_list(catalog, slots[slot_name])
    slots[slot_name]["picks"] = [sprites[int(n)][2] for n in numbers]
    save_slots(slots)
    print(slot_name, slots[slot_name]["picks"])


def contact(catalog, slot_name, out_path):
    slots = load_slots()
    slot = slots[slot_name]
    sprites = browse_list(catalog, slot)
    cols, scale, cell_w, cell_h = 16, 3, 16 * 3 + 4, 16 * 3 + 10
    rows = (len(sprites) + cols - 1) // cols
    width, height = cols * cell_w, rows * cell_h
    canvas = bytearray(b"\x40\x40\x48\xff" * width * height)

    def put(x, y, color):
        if 0 <= x < width and 0 <= y < height:
            canvas[(y * width + x) * 4:(y * width + x) * 4 + 4] = color

    labels = []
    for n, (subject, offset, sprite) in enumerate(sprites):
        cx, cy = (n % cols) * cell_w + 2, (n // cols) * cell_h + 2
        pixels = catalog.rgba(sprite)
        for p in range(256):
            if pixels[p * 4 + 3]:
                for dy in range(scale):
                    for dx in range(scale):
                        put(cx + (p % 16) * scale + dx, cy + (p // 16) * scale + dy, pixels[p * 4:p * 4 + 4])
        for k, ch in enumerate(str(n)):
            glyph = DIGITS[int(ch)]
            for g in range(15):
                if glyph[g] == "1":
                    put(cx + k * 4 + g % 3, cy + 49 + g // 3, b"\xff\xff\x80\xff")
        labels.append(f"{n}={sprite}")
    with open(out_path, "wb") as handle:
        handle.write(png(width, height, bytes(canvas)))
    print(out_path, len(sprites), "sprites;", "subjects:", slot["subjects"])
    print("label=catalog id: " + " ".join(labels))


def load_slots():
    with open(os.path.join(ROOT, "tools", "sprite_slots.json")) as handle:
        return json.load(handle)


def save_slots(slots):
    with open(os.path.join(ROOT, "tools", "sprite_slots.json"), "w") as handle:
        handle.write("{\n" + ",\n".join(f'  "{k}": {json.dumps(v)}' for k, v in slots.items()) + "\n}\n")


def build(catalog):
    """Writes candidate PNGs, the chosen sprite per slot to assets/sprites/<slot>.png, and the sheet."""
    slots = load_slots()
    sheet = {}
    assets = os.path.join(ROOT, "assets", "sprites")
    os.makedirs(assets, exist_ok=True)
    for name, slot in slots.items():
        folder = os.path.join(ROOT, "design", "candidates", name)
        os.makedirs(folder, exist_ok=True)
        entries = []
        chosen = slot.get("chosen")
        ordered = ([chosen] if chosen in slot["picks"] else []) + [s for s in slot["picks"] if s != chosen]
        for sprite in ordered:
            data = png(16, 16, catalog.rgba(sprite))
            with open(os.path.join(folder, f"{sprite}.png"), "wb") as handle:
                handle.write(data)
            if sprite == chosen:
                with open(os.path.join(assets, f"{name}.png"), "wb") as handle:
                    handle.write(data)
            entries.append({"id": sprite, "subject": catalog.subject_of(sprite),
                            "src": "data:image/png;base64," + base64.b64encode(data).decode()})
        sheet[name] = entries
        print(f"{name}: {len(entries)}")
    template_path = os.path.join(ROOT, "design", "concept-sheet.template.html")
    with open(template_path) as handle:
        template = handle.read()
    marker = "/*SPRITES*/{}"
    assert marker in template, "template is missing the /*SPRITES*/{} marker"
    with open(os.path.join(ROOT, "design", "concept-sheet.html"), "w") as handle:
        handle.write(template.replace(marker, json.dumps(sheet, separators=(",", ":"))))
    print("wrote design/concept-sheet.html")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "find":
        find(Catalog(), sys.argv[2])
    elif command == "pick":
        pick(Catalog(), sys.argv[2], sys.argv[3:])
    elif command == "contact":
        contact(Catalog(), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else f"{sys.argv[2]}.png")
    elif command == "build":
        build(Catalog())
    else:
        sys.exit(__doc__)

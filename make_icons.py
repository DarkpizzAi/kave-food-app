"""Derive the app icon set from icon-512.png, the master artwork.

Run after replacing icon-512.png, then bump VERSION in service-worker.js.

  python make_icons.py

- icon-192.png          same transparent artwork, 192x192 ("any" purpose)
- icon-512-maskable.png opaque BG, artwork at 70% so it survives any launcher
                        crop shape (the maskable safe zone is the centre 80%)
- apple-touch-icon.png  180x180, flattened onto BG (iOS paints alpha black)

BG must stay in step with theme_color / background_color in manifest.json.
"""
from PIL import Image

BG = (244, 247, 253)  # #f4f7fd, the Cobalt light background
MASTER = "icon-512.png"


def flatten(art, size):
    scaled = art.resize((size, size), Image.LANCZOS)
    out = Image.new("RGB", (size, size), BG)
    out.paste(scaled, (0, 0), scaled)
    return out


def main():
    art = Image.open(MASTER).convert("RGBA")

    art.resize((192, 192), Image.LANCZOS).save("icon-192.png")

    inner = round(512 * 0.70)
    mask = Image.new("RGB", (512, 512), BG)
    scaled = art.resize((inner, inner), Image.LANCZOS)
    off = (512 - inner) // 2
    mask.paste(scaled, (off, off), scaled)
    mask.save("icon-512-maskable.png")

    flatten(art, 180).save("apple-touch-icon.png")
    print("wrote icon-192.png, icon-512-maskable.png, apple-touch-icon.png")


if __name__ == "__main__":
    main()

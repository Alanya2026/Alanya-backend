"""
Génère les GIF de test de V1c (stickers animés) — `python3 -I generer.py`.

Pillow seul, déterministe (graine fixe) : les fichiers de ce dossier sont des
fixtures binaires lues par `src/utils/stickerAnime.test.js`. À régénérer
seulement si la liste ci-dessous change.

  gif-30-carre.gif          30 images 320x320, 100 ms (3 000 ms), contenu simple
  gif-40-lent.gif           40 images 320x320, 100 ms (4 000 ms) : tronqué à 3 s (30 images)
  gif-60-non-carre.gif      60 images 320x240, 66 ms (≈ 4 s : sera tronqué à 3 s)
  gif-bruite-lourd.gif      4 images 512x512 de bruit (≈ 1,4 Mo) : ne tient pas en 300 Ko
  gif-6000x6000.gif         2 images 6000x6000 unies (quelques Ko : bombe de pixels)
  gif-2000x2000-20.gif      20 images 2000x2000 unies (80 Mpx : bombe mémoire)
  gif-301-pages.gif         301 images 16x16 (bombe de pages)
"""
import os
import random
from PIL import Image, ImageDraw

ICI = os.path.dirname(os.path.abspath(__file__))
random.seed(237)


def enregistrer(nom, images, duree):
    images[0].save(
        os.path.join(ICI, nom), save_all=True, append_images=images[1:],
        duration=duree, loop=0, optimize=False, disposal=2,
    )


def cercle_qui_bouge(n, w, h, duree):
    images = []
    for i in range(n):
        im = Image.new('RGB', (w, h))
        d = ImageDraw.Draw(im)
        # Dégradé simple (quelques aplats : très compressible).
        for y in range(0, h, 8):
            d.rectangle([0, y, w, y + 8], fill=(40 + (y * 180) // h, 90, 200 - (y * 120) // h))
        cx = int(w * (0.2 + 0.6 * i / max(1, n - 1)))
        cy = h // 2
        r = min(w, h) // 5
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(250, 210, 40))
        d.ellipse([cx - r // 3, cy - r // 3, cx + r // 3, cy + r // 3], fill=(200, 30, 30))
        # Les coins restent colorés : si la forme (cercle) mord, on le verra à l'alpha.
        images.append(im.convert('P', palette=Image.ADAPTIVE))
    return images


enregistrer('gif-30-carre.gif', cercle_qui_bouge(30, 320, 320, 100), 100)
enregistrer('gif-40-lent.gif', cercle_qui_bouge(40, 320, 320, 100), 100)
enregistrer('gif-60-non-carre.gif', cercle_qui_bouge(60, 320, 240, 66), 66)

bruit = []
for i in range(4):
    octets = bytes(random.getrandbits(8) for _ in range(512 * 512))
    im = Image.frombytes('P', (512, 512), octets)
    im.putpalette([random.getrandbits(8) for _ in range(768)])
    bruit.append(im)
enregistrer('gif-bruite-lourd.gif', bruit, 100)

for nom, n, cote in (('gif-6000x6000.gif', 2, 6000), ('gif-2000x2000-20.gif', 20, 2000)):
    images = [Image.new('P', (cote, cote), color=i % 255) for i in range(n)]
    enregistrer(nom, images, 100)

enregistrer('gif-301-pages.gif', [Image.new('P', (16, 16), color=i % 255) for i in range(301)], 20)

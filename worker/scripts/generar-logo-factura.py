"""Genera worker/src/logo-factura.js: el logo de Don Sticker listo para incrustar en el PDF de la factura.

El servidor no puede decodificar PNG sin librerías, así que acá se deja el logo ya en el formato que usa PDF:
colores (RGB) y transparencia (alfa) por separado, comprimidos con zlib (FlateDecode) y en Base64.

Uso (desde D:\\proyectos\\Stickers):  python worker/scripts/generar-logo-factura.py [ruta-al-logo.png]
El PNG de entrada es el logo horizontal con fondo transparente (se genera desde web/assets/logo-horizontal.svg).
"""
import base64, sys, zlib
from pathlib import Path
from PIL import Image

RAIZ = Path(__file__).resolve().parents[2]
origen = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "AppData/Local/Temp/logo-factura.png"
ANCHO = 420  # píxeles: sobra para 122 pt de ancho en el PDF (≈ 250 dpi)

im = Image.open(origen).convert("RGBA")
alto = round(im.height * ANCHO / im.width)
im = im.resize((ANCHO, alto), Image.LANCZOS)
rgb = Image.new("RGB", im.size, (255, 255, 255))
rgb.paste(im, mask=im.getchannel("A"))
b64 = lambda datos: base64.b64encode(zlib.compress(datos, 9)).decode()

salida = RAIZ / "worker/src/logo-factura.js"
salida.write_text(
    "// GENERADO por worker/scripts/generar-logo-factura.py: no editar a mano.\n"
    "// Logo de Don Sticker para el PDF de la factura: colores y transparencia, comprimidos (zlib) y en Base64.\n"
    f"export const LOGO = {{ ancho: {ANCHO}, alto: {alto}, rgb: \"{b64(rgb.tobytes())}\", alfa: \"{b64(im.getchannel('A').tobytes())}\" }};\n",
    encoding="utf8",
)
print(f"{salida.name}: {ANCHO}x{alto}, {salida.stat().st_size // 1024} KB")

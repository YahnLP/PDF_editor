# PDF "réaliste" produit par Chrome (Skia/PDF) : polices TrueType intégrées, texte en TJ, images dans le flux
import asyncio, sys
from playwright.async_api import async_playwright
HTML = '''<html><body style="font-family:Georgia,serif;margin:50px">
<h1 style="color:#8a1c1c">Facture n° 2026-117</h1>
<p style="font-size:15px">Client : <b>Société Exemple SARL</b> — 12 rue des Lilas, 75011 Paris</p>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#333">Prestation de conseil, forfait mensuel : 1 250,00 € HT</p>
<div style="background:#e9eef7;padding:14px;border-radius:6px;font-family:Verdana,sans-serif;font-size:14px">Total TTC : <b>1 500,00 €</b></div>
<p><img src="file:///tmp/test_img.png" width="260"></p>
<p style="font-family:monospace;font-size:12px">IBAN FR76 3000 6000 0112 3456 7890 189</p>
</body></html>'''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--allow-file-access-from-files'])
        pg = await b.new_page()
        open('/tmp/chrome_src.html', 'w').write(HTML)
        await pg.goto('file:///tmp/chrome_src.html')
        await pg.pdf(path=sys.argv[1], format='A4')
        await b.close()
asyncio.run(main())

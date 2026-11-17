# PDF "titre dessiné" : le titre visible est une image, le vrai texte est une couche invisible (rendu 3), comme un PDF OCR
import sys
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf', 200)
im = Image.new('RGB', (1300, 520), 'white'); d = ImageDraw.Draw(im)
d.text((0, 0), 'QUEL EST', font=f, fill='#202530'); d.text((0, 250), 'MON', font=f, fill='#202530'); d.text((470, 250), 'PALIER', font=f, fill='#c05a00')
im.save('/tmp/title_img.png')
c = canvas.Canvas(sys.argv[1], pagesize=(595, 842))
c.drawImage('/tmp/title_img.png', 50, 520, width=455, height=182)
t = c.beginText(50, 560); t.setFont('Helvetica', 60); t.setTextRenderMode(3); t.textLine('MON PALIER'); c.drawText(t)
t = c.beginText(50, 647); t.setFont('Helvetica', 60); t.setTextRenderMode(3); t.textLine('QUEL EST'); c.drawText(t)
c.setFont('Helvetica', 14); c.drawString(50, 480, 'Texte normal visible')
c.save()

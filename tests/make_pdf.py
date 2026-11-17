import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from PIL import Image, ImageDraw
out = sys.argv[1]
im = Image.new('RGB', (300, 200), (230, 80, 60)); d = ImageDraw.Draw(im)
d.ellipse((40, 30, 260, 170), fill=(250, 220, 60)); d.rectangle((120, 80, 180, 120), fill=(30, 60, 160))
im.save('/tmp/test_img.png')
c = canvas.Canvas(out, pagesize=A4)
W, H = A4
c.setFont('Helvetica-Bold', 24); c.drawString(72, H - 90, 'Rapport trimestriel')
c.setFont('Helvetica', 12); c.drawString(72, H - 120, 'Ceci est une ligne de texte en Helvetica pour tester la modification.')
c.setFont('Times-Italic', 14); c.drawString(72, H - 150, 'Une citation en Times italique, très élégante.')
c.setFont('Courier', 11); c.drawString(72, H - 180, 'code = "monospace"; // ligne Courier')
c.setFillColorRGB(0.1, 0.2, 0.5); c.rect(72, H - 260, 300, 50, fill=1, stroke=0)
c.setFillColorRGB(1, 1, 1); c.setFont('Helvetica-Bold', 16); c.drawString(84, H - 240, 'Texte blanc sur fond bleu')
c.drawImage('/tmp/test_img.png', 72, H - 520, width=240, height=160)
c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica', 10); c.drawString(72, H - 545, 'Légende de l\'image : figure 1')
c.showPage()
c.setFont('Helvetica', 14); c.drawString(72, H - 100, 'Page deux')
c.save()

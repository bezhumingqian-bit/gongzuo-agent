from pathlib import Path

from PIL import Image, ImageDraw


SIZE = 1024
SCALE = 2
CANVAS = SIZE * SCALE

image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

margin = 92 * SCALE
radius = 230 * SCALE
draw.rounded_rectangle(
    (margin, margin, CANVAS - margin, CANVAS - margin),
    radius=radius,
    fill="#232733",
)

cx = cy = CANVAS // 2
outer = 250 * SCALE
inner = 66 * SCALE
points = [
    (cx, cy - outer),
    (cx + inner, cy - inner),
    (cx + outer, cy),
    (cx + inner, cy + inner),
    (cx, cy + outer),
    (cx - inner, cy + inner),
    (cx - outer, cy),
    (cx - inner, cy - inner),
]
draw.line(points + [points[0]], fill="#CCFF45", width=26 * SCALE, joint="curve")

output = Path(__file__).resolve().parents[1] / "build" / "icon.png"
output.parent.mkdir(parents=True, exist_ok=True)
image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(output)
print(output)

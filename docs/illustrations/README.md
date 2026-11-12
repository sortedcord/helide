# Feature illustrations

Self-contained animated SVGs used in the main README. These are schematic
explanations, not screenshots or measurements of performance/battery savings.

## Palette

Based on the project's personal Kitty palette (Tokyo Night Terminal Storm):

| Use | Color |
| --- | --- |
| Background | `#0e1017` |
| Surfaces | `#24283B` |
| Borders | `#444B6A` |
| Primary text | `#D5D6DB` |
| Secondary text | `#787C99` |
| Periwinkle | `#8698df` |
| Teal | `#41A6B5` |
| Purple | `#BB9AF7` |
| Warm yellow | `#E0AF68` |
| Rose | `#F7768E` |

## Conventions

- Use the same `720 × 260` view box and rounded dark canvas.
- Embed as an image; no JavaScript, remote assets, web fonts or HTML foreign objects.
- Give each SVG a descriptive title and description; README images also have alt text.
- Animate simple opacity/transforms with CSS. Every animated element has a
  `motion` class, disabled under `prefers-reduced-motion: reduce`.
- Make the reduced-motion state understandable without animation.
- Keep controls/text opaque when illustrating background transparency.
- Preview both as standalone SVG and embedded in an `<img>` element. Check
  multiple animation phases and the reduced-motion fallback before publishing.

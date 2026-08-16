# Frame-pack handoff

`assets/frame-packs/index.json` lists the frame-pack folders shown in the operator. Each pack contains a `manifest.json`, an overlay image, and a thumbnail image. Start by duplicating `assets/frame-packs/basic`, then give the new pack a unique `id`, update its human-readable `label`, and add its folder name to the index.

## Assets and placement

Set `thumbnail` and `overlay` to files inside the pack. The overlay is painted after all four photos, so it can provide borders, type, and other stable visual treatment. It must not include a participant-specific QR code or personal data. Stable club identity and application-site branding are allowed.

The final output canvas is measured in pixels. In `slots`, measure each of the four photo rectangles in that final-canvas coordinate system: `x` and `y` are the top-left point, and `width` and `height` are positive dimensions. Slots are used in capture-selection order (first selected image through fourth selected image), use `fit: "cover"`, and `rotation` is clockwise degrees around the slot center. Every pack must have exactly four slots.

## Validation and local preview

From the repository root, validate frame behavior with:

```bash
npm test -- tests/operator/frames
```

Run the operator locally with `npm run dev`; the private listener exposes the configured pack collection at `/frame-pack/`. Confirm each overlay is on top of the four photos and that all slot measurements match the final canvas. The checked-in `basic` pack is a neutral fixture and is not listed in the production index.
